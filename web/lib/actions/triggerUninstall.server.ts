/**
 * Action core: trigger a machine-direct software uninstall.
 *
 * security-boundary-migration wave 3.5.
 *
 * Writes an `uninstall_software` command into
 * `sites/{siteId}/machines/{machineId}/commands/pending` for the named
 * package. Mirrors the per-command shape historically produced by
 * `useUninstall.ts:createUninstall` (so the agent processes it identically),
 * with lifecycle fields layered on by `stampCommand`.
 *
 * Software metadata (`uninstall_command`, `installer_type`, `install_location`)
 * is read server-side from the machine's `installed_software` collection —
 * exactly what the legacy hook did client-side via `fetchMachineSoftware`.
 *
 * Capability `UNINSTALL_TRIGGER`. Site-scoped (admin role gates wired through
 * `authorizedSiteHandler`).
 *
 * Distinct from `/api/sites/{siteId}/deployments/{deploymentId}/uninstall`,
 * which is the deployment-level fan-out variant — this core is single-machine,
 * not deployment-tied.
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { stampCommand } from '@/lib/commandLifecycle';

/** Result of a successful trigger — surfaced to the route shim. */
export interface TriggerUninstallResult {
  siteId: string;
  machineId: string;
  software_name: string;
  commandId: string;
  status: 'pending';
}

export type TriggerUninstallErrorCode =
  | 'validation_failed'
  | 'machine_not_found'
  | 'machine_offline'
  | 'software_not_found'
  | 'software_record_invalid';

export class TriggerUninstallError extends Error {
  readonly code: TriggerUninstallErrorCode;
  readonly fieldErrors?: Record<string, string[]>;
  constructor(
    code: TriggerUninstallErrorCode,
    message: string,
    fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'TriggerUninstallError';
    this.code = code;
    if (fieldErrors) this.fieldErrors = fieldErrors;
  }
}

export interface TriggerUninstallInput {
  /** Display name of the software (must match a doc in `installed_software`). */
  software_name: string;
  /**
   * Optional list of process exe names to terminate before uninstalling.
   * Forwarded into the agent payload verbatim. Reserved for forward-compat
   * with future agent support — current uninstall handler does not consume
   * this field, but unknown-field tolerance means it is safe to include.
   */
  close_processes?: string[];
  /** Optional override for the agent's per-command timeout. Bounded to a sane range. */
  timeout_seconds?: number;
}

export interface TriggerUninstallOptions {
  /** Inject a Firestore instance — tests pass a mock. */
  db?: Firestore;
  /** Override the wall-clock now — unit tests use this for determinism. */
  now?: () => number;
  /** Audit correlation id from `authorizedSiteHandler`. */
  auditCorrelationId?: string;
  /**
   * Skip the `online === false` precheck. Mirrors the deployment-tied
   * uninstall route, which also queues even for offline machines (the
   * agent picks the command up on next reconnect). Set `true` to opt out
   * if the calling surface wants the same gate as the generic commands
   * route. Default: skip the gate.
   */
  requireOnline?: boolean;
}

/* ── input validation ─────────────────────────────────────────────────── */

const TIMEOUT_MIN_S = 1;
const TIMEOUT_MAX_S = 24 * 60 * 60; // 24h ceiling, matches the agent's longest job allowance.
const SOFTWARE_NAME_MAX = 256;
const CLOSE_PROCESSES_MAX = 32;

/**
 * Parse + validate a raw payload coming from the route handler. Throws
 * `TriggerUninstallError(validation_failed, ...)` on bad input so the route
 * can render an RFC 7807 problem+json envelope.
 */
export function parseTriggerUninstallInput(raw: unknown): TriggerUninstallInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TriggerUninstallError(
      'validation_failed',
      'request body must be a json object',
      { body: ['must be a json object'] },
    );
  }
  const body = raw as Record<string, unknown>;

  // software_name — required, non-empty string, length-bounded.
  if (typeof body.software_name !== 'string') {
    throw new TriggerUninstallError(
      'validation_failed',
      'field `software_name` is required and must be a non-empty string',
      { 'body.software_name': ['required non-empty string'] },
    );
  }
  const softwareName = body.software_name.trim();
  if (softwareName.length === 0) {
    throw new TriggerUninstallError(
      'validation_failed',
      'field `software_name` is required and must be a non-empty string',
      { 'body.software_name': ['required non-empty string'] },
    );
  }
  if (softwareName.length > SOFTWARE_NAME_MAX) {
    throw new TriggerUninstallError(
      'validation_failed',
      `field \`software_name\` exceeds ${SOFTWARE_NAME_MAX} characters`,
      { 'body.software_name': [`max ${SOFTWARE_NAME_MAX} chars`] },
    );
  }

  // close_processes — optional array of non-empty strings.
  let closeProcesses: string[] | undefined;
  if (body.close_processes !== undefined && body.close_processes !== null) {
    if (!Array.isArray(body.close_processes)) {
      throw new TriggerUninstallError(
        'validation_failed',
        'field `close_processes` must be an array of strings when provided',
        { 'body.close_processes': ['must be an array of strings'] },
      );
    }
    if (body.close_processes.length > CLOSE_PROCESSES_MAX) {
      throw new TriggerUninstallError(
        'validation_failed',
        `field \`close_processes\` exceeds ${CLOSE_PROCESSES_MAX} entries`,
        { 'body.close_processes': [`max ${CLOSE_PROCESSES_MAX} entries`] },
      );
    }
    const cleaned: string[] = [];
    for (const entry of body.close_processes) {
      if (typeof entry !== 'string' || entry.trim().length === 0) {
        throw new TriggerUninstallError(
          'validation_failed',
          'field `close_processes` must be an array of non-empty strings',
          { 'body.close_processes': ['entries must be non-empty strings'] },
        );
      }
      cleaned.push(entry.trim());
    }
    closeProcesses = cleaned;
  }

  // timeout_seconds — optional positive integer, clamped to [1, 24h].
  let timeoutSeconds: number | undefined;
  if (body.timeout_seconds !== undefined && body.timeout_seconds !== null) {
    const n = Number(body.timeout_seconds);
    if (!Number.isFinite(n) || n <= 0) {
      throw new TriggerUninstallError(
        'validation_failed',
        'field `timeout_seconds` must be a positive number when provided',
        { 'body.timeout_seconds': ['must be > 0'] },
      );
    }
    timeoutSeconds = Math.min(Math.max(Math.floor(n), TIMEOUT_MIN_S), TIMEOUT_MAX_S);
  }

  const out: TriggerUninstallInput = { software_name: softwareName };
  if (closeProcesses !== undefined) out.close_processes = closeProcesses;
  if (timeoutSeconds !== undefined) out.timeout_seconds = timeoutSeconds;
  return out;
}

/* ── action core ──────────────────────────────────────────────────────── */

/**
 * Look up the machine's `installed_software` for the named package.
 * Returns the matching software record or `null` if absent.
 *
 * `installed_software` doc ids are not predictable (the agent uses a
 * fingerprint of the registry key), so we query by the `name` field.
 */
async function findSoftwareRecord(
  db: Firestore,
  siteId: string,
  machineId: string,
  softwareName: string,
): Promise<Record<string, unknown> | null> {
  const ref = db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('installed_software');
  const snap = await ref.where('name', '==', softwareName).limit(1).get();
  if (snap.empty) return null;
  const data = snap.docs[0].data();
  return data ?? null;
}

/**
 * Trigger a machine-direct uninstall. Writes one `uninstall_software`
 * command into the machine's `commands/pending` map.
 *
 * The on-wire command shape MUST match the legacy client-side write so the
 * agent's existing handler processes it identically. See `useUninstall.ts`.
 */
export async function triggerUninstall(
  siteId: string,
  machineId: string,
  input: TriggerUninstallInput,
  options: TriggerUninstallOptions = {},
): Promise<TriggerUninstallResult> {
  if (!siteId) throw new TriggerUninstallError('validation_failed', 'siteId is required');
  if (!machineId) throw new TriggerUninstallError('validation_failed', 'machineId is required');

  const db = options.db ?? getAdminDb();
  const now = options.now ? options.now() : Date.now();

  // 1. Verify the machine exists; optionally gate on `online`.
  const machineRef = db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId);
  const machineSnap = await machineRef.get();
  if (!machineSnap.exists) {
    throw new TriggerUninstallError(
      'machine_not_found',
      `machine ${machineId} not found on site ${siteId}`,
    );
  }
  if (options.requireOnline) {
    const machineData = machineSnap.data() ?? {};
    if (machineData.online === false) {
      throw new TriggerUninstallError(
        'machine_offline',
        `machine ${machineId} is currently offline; uninstall cannot be queued ` +
          `until it reconnects`,
      );
    }
  }

  // 2. Resolve software record from the machine's installed_software.
  const record = await findSoftwareRecord(db, siteId, machineId, input.software_name);
  if (!record) {
    throw new TriggerUninstallError(
      'software_not_found',
      `software "${input.software_name}" is not installed on machine ${machineId}`,
    );
  }
  const uninstallCommand = record.uninstall_command;
  if (typeof uninstallCommand !== 'string' || uninstallCommand.length === 0) {
    throw new TriggerUninstallError(
      'software_record_invalid',
      `software "${input.software_name}" has no recorded uninstall command; ` +
        `cannot trigger uninstall`,
    );
  }
  const installerType =
    typeof record.installer_type === 'string' && record.installer_type.length > 0
      ? record.installer_type
      : 'custom';
  const installLocation =
    typeof record.install_location === 'string' && record.install_location.length > 0
      ? record.install_location
      : '';
  const verifyPaths = installLocation ? [installLocation] : [];

  // 3. Build command payload — bit-for-bit match against useUninstall.ts.
  const commandBody: Record<string, unknown> = {
    type: 'uninstall_software',
    software_name: input.software_name,
    uninstall_command: uninstallCommand,
    installer_type: installerType,
    verify_paths: verifyPaths,
    timestamp: FieldValue.serverTimestamp(),
  };
  if (input.close_processes !== undefined) {
    commandBody.close_processes = input.close_processes;
  }
  if (input.timeout_seconds !== undefined) {
    commandBody.timeout_seconds = input.timeout_seconds;
  }

  const stamped = stampCommand(commandBody, {
    auditCorrelationId: options.auditCorrelationId,
    now: () => now,
  });

  // 4. Map-merge write under a unique commandId. Prefix matches the legacy
  //    `uninstall-${Date.now()}` shape so existing dashboard listeners (and
  //    the agent's own command-id prefix tracking) continue to recognise it.
  const commandId = `uninstall-${now}`;
  const pendingRef = machineRef.collection('commands').doc('pending');
  await pendingRef.set({ [commandId]: stamped }, { merge: true });

  return {
    siteId,
    machineId,
    software_name: input.software_name,
    commandId,
    status: 'pending',
  };
}
