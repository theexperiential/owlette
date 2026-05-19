/**
 * Action core: cancel an in-flight machine-direct software uninstall.
 *
 * security-boundary-migration wave 3.5.
 *
 * Writes a `cancel_uninstall` command into
 * `sites/{siteId}/machines/{machineId}/commands/pending`. The agent
 * matches by `software_name` and signals its in-flight uninstall worker
 * (see `owlette_service.py: cmd_type == 'cancel_uninstall'`).
 *
 * Capability `UNINSTALL_TRIGGER`. Site-scoped — capability check enforced
 * in the route shim via `authorizedSiteHandler`.
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { stampCommand } from '@/lib/commandLifecycle';

export interface CancelUninstallResult {
  siteId: string;
  machineId: string;
  software_name: string;
  commandId: string;
  status: 'pending';
}

export type CancelUninstallErrorCode =
  | 'validation_failed'
  | 'machine_not_found';

export class CancelUninstallError extends Error {
  readonly code: CancelUninstallErrorCode;
  readonly fieldErrors?: Record<string, string[]>;
  constructor(
    code: CancelUninstallErrorCode,
    message: string,
    fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'CancelUninstallError';
    this.code = code;
    if (fieldErrors) this.fieldErrors = fieldErrors;
  }
}

export interface CancelUninstallInput {
  /** Display name of the software whose uninstall should be cancelled. */
  software_name: string;
}

export interface CancelUninstallOptions {
  /** Inject a Firestore instance — tests pass a mock. */
  db?: Firestore;
  /** Override the wall-clock now — unit tests use this for determinism. */
  now?: () => number;
  /** Audit correlation id from `authorizedSiteHandler`. */
  auditCorrelationId?: string;
}

const SOFTWARE_NAME_MAX = 256;

/**
 * Parse + validate a raw payload coming from the route handler. Throws
 * `CancelUninstallError(validation_failed, ...)` on bad input so the route
 * can render an RFC 7807 problem+json envelope. Accepts the body as either
 * JSON or query params (DELETE-with-body is awkward; route may take
 * `?software_name=...` instead).
 */
export function parseCancelUninstallInput(raw: unknown): CancelUninstallInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CancelUninstallError(
      'validation_failed',
      'request must include a software_name',
      { 'body.software_name': ['required non-empty string'] },
    );
  }
  const body = raw as Record<string, unknown>;
  if (typeof body.software_name !== 'string') {
    throw new CancelUninstallError(
      'validation_failed',
      'field `software_name` is required and must be a non-empty string',
      { 'body.software_name': ['required non-empty string'] },
    );
  }
  const softwareName = body.software_name.trim();
  if (softwareName.length === 0) {
    throw new CancelUninstallError(
      'validation_failed',
      'field `software_name` is required and must be a non-empty string',
      { 'body.software_name': ['required non-empty string'] },
    );
  }
  if (softwareName.length > SOFTWARE_NAME_MAX) {
    throw new CancelUninstallError(
      'validation_failed',
      `field \`software_name\` exceeds ${SOFTWARE_NAME_MAX} characters`,
      { 'body.software_name': [`max ${SOFTWARE_NAME_MAX} chars`] },
    );
  }
  return { software_name: softwareName };
}

/**
 * Cancel a machine-direct uninstall. Writes one `cancel_uninstall` command
 * into the machine's `commands/pending` map. Shape matches the legacy
 * `useUninstall.ts:cancelUninstall` write so the agent processes it
 * identically.
 */
export async function cancelUninstall(
  siteId: string,
  machineId: string,
  input: CancelUninstallInput,
  options: CancelUninstallOptions = {},
): Promise<CancelUninstallResult> {
  if (!siteId) throw new CancelUninstallError('validation_failed', 'siteId is required');
  if (!machineId) throw new CancelUninstallError('validation_failed', 'machineId is required');

  const db = options.db ?? getAdminDb();
  const now = options.now ? options.now() : Date.now();

  // Verify the machine exists. Skipped online-gating — cancel is meaningful
  // even when the machine is briefly offline (the cancel is consumed
  // alongside the in-flight uninstall when the agent reconnects).
  const machineRef = db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId);
  const machineSnap = await machineRef.get();
  if (!machineSnap.exists) {
    throw new CancelUninstallError(
      'machine_not_found',
      `machine ${machineId} not found on site ${siteId}`,
    );
  }

  const commandBody: Record<string, unknown> = {
    type: 'cancel_uninstall',
    software_name: input.software_name,
    timestamp: FieldValue.serverTimestamp(),
  };

  const stamped = stampCommand(commandBody, {
    auditCorrelationId: options.auditCorrelationId,
    now: () => now,
  });

  const commandId = `cancel-uninstall-${now}`;
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
