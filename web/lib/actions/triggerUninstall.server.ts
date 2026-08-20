/**
 * Action core: machine-direct software uninstall.
 *
 * Writes an `uninstall_software` command into `sites/{siteId}/machines/{machineId}/commands/pending`
 * in the exact shape `useUninstall.ts:createUninstall` produced, so the agent handles it
 * identically, plus lifecycle fields from `stampCommand`. Software metadata comes server-side from
 * the machine's `installed_software` collection.
 *
 * Capability `UNINSTALL_TRIGGER`, site-scoped via `authorizedSiteHandler`. Single-machine —
 * `/api/sites/{siteId}/deployments/{deploymentId}/uninstall` is the deployment fan-out variant.
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { stampCommand } from '@/lib/commandLifecycle';

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
   * Exe names to terminate before uninstalling, forwarded verbatim. The current agent handler
   * ignores it; it is safe to send because the agent tolerates unknown fields.
   */
  close_processes?: string[];
  /** Overrides the agent's per-command timeout; clamped to [1s, 24h]. */
  timeout_seconds?: number;
}

export interface TriggerUninstallOptions {
  /** Tests pass a mock. */
  db?: Firestore;
  /** Tests override for determinism. */
  now?: () => number;
  /** Audit correlation id from `authorizedSiteHandler`. */
  auditCorrelationId?: string;
  /**
   * Default false: queue even for offline machines (the agent picks the command up on reconnect),
   * matching the deployment-tied uninstall route. Set true for the generic commands route's gate.
   */
  requireOnline?: boolean;
}

const TIMEOUT_MIN_S = 1;
const TIMEOUT_MAX_S = 24 * 60 * 60; // matches the agent's longest job allowance
const SOFTWARE_NAME_MAX = 256;
const CLOSE_PROCESSES_MAX = 32;

/** Throws `TriggerUninstallError(validation_failed)` so the route can render RFC 7807. */
export function parseTriggerUninstallInput(raw: unknown): TriggerUninstallInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TriggerUninstallError(
      'validation_failed',
      'request body must be a json object',
      { body: ['must be a json object'] },
    );
  }
  const body = raw as Record<string, unknown>;

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

/**
 * Queried by the `name` field, not doc id — the agent derives ids from a registry-key fingerprint,
 * so they are not predictable.
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
 * Writes one `uninstall_software` command into the machine's `commands/pending` map. The on-wire
 * shape MUST match the legacy client-side write in `useUninstall.ts` — the agent's handler is the
 * same code path.
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

  // Bit-for-bit match against useUninstall.ts.
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

  // The `uninstall-` prefix is load-bearing: dashboard listeners and the agent's command-id prefix
  // tracking both match on it.
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
