/**
 * Audit-log writer for reconciler cloud functions
 * (security-boundary-migration wave 2.4).
 *
 * Mirrors the on-disk schema of `web/lib/auditLog.server.ts` so a
 * consumer pulling `sites/{siteId}/audit_log` cannot tell whether a
 * given row was written by the next.js api or by a cloud function.
 * The cloud function package is independent of `web/` (separate npm
 * project, separate tsconfig), so the writer is duplicated here rather
 * than imported. The shape MUST stay in sync with the web copy — both
 * paths land in the same firestore collection.
 *
 * Reconciler audit entries always carry:
 *   actor: { type: 'system', name: 'deployment_reconciler' | 'distribution_reconciler' }
 *   outcome: 'allow' | 'error'
 *   target.kind: 'deployment' | 'distribution'
 *   metadata.machineId: <machine the command came from>
 *   metadata.commandId: <map key in commands/pending>
 *   metadata.previousStatus / metadata.newStatus: parent-level transition
 *
 * `correlationId` is the per-command audit id stamped at command-creation
 * time (wave 2.1's `authorizedHandler` will mint it). Reusing it here
 * lets investigators pivot from a command's authorisation row to the
 * reconciler row that observed its completion, and from there to any
 * downstream state changes that referenced the same id.
 */

import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';

const AUDIT_LOG_COLLECTION = 'audit_log';

export type ReconcilerActorName =
  | 'deployment_reconciler'
  | 'distribution_reconciler';

export type ReconcilerCapability =
  | 'DEPLOYMENT_MANAGE'
  | 'DISTRIBUTION_MANAGE';

export type ReconcilerTargetKind = 'deployment' | 'distribution';

export type ReconcilerOutcome = 'allow' | 'error';

export interface ReconcilerAuditInput {
  siteId: string;
  correlationId: string;
  actorName: ReconcilerActorName;
  capability: ReconcilerCapability;
  targetKind: ReconcilerTargetKind;
  targetId: string;
  machineId: string;
  outcome: ReconcilerOutcome;
  metadata?: Record<string, unknown>;
  errorCode?: string;
}

/**
 * Write a reconciler audit entry. Throws on firestore failure — the
 * caller decides whether to swallow (most do, since the parent-doc
 * write IS the state change being audited and an audit failure
 * shouldn't leave the parent doc in a half-reconciled state).
 *
 * Returns the document id of the new audit row so callers can include
 * it in structured logs.
 */
export async function writeReconcilerAuditEntry(
  input: ReconcilerAuditInput,
): Promise<string> {
  if (!input.siteId) {
    throw new Error('writeReconcilerAuditEntry: siteId is required');
  }
  if (!input.correlationId) {
    throw new Error('writeReconcilerAuditEntry: correlationId is required');
  }

  const db = admin.firestore();
  const docRef = db
    .collection('sites')
    .doc(input.siteId)
    .collection(AUDIT_LOG_COLLECTION)
    .doc();

  const payload: Record<string, unknown> = {
    correlationId: input.correlationId,
    actor: { type: 'system', name: input.actorName },
    capability: input.capability,
    target: stripUndefined({
      kind: input.targetKind,
      id: input.targetId,
      machineId: input.machineId,
    }),
    outcome: input.outcome,
    timestamp: FieldValue.serverTimestamp(),
  };
  if (input.metadata !== undefined) payload.metadata = input.metadata;
  if (input.errorCode !== undefined) payload.errorCode = input.errorCode;

  await docRef.set(payload);
  return docRef.id;
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(obj) as Array<keyof T>) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}
