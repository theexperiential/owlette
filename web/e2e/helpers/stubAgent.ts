/**
 * Agent-dispatch stubs (D1.1).
 *
 * When a web command is dispatched (reboot, shutdown, kill-process,
 * apply-display-layout, etc.) the agent picks it up from
 * `sites/{siteId}/machines/{machineId}/commands/pending`, runs it, and
 * then calls `_mark_command_completed` (or `_mark_command_failed`) to:
 *
 *   1. Write to `sites/{siteId}/machines/{machineId}/commands/completed`
 *      with `{ [commandId]: { result, status, completedAt, … } }`,
 *      merged into the existing doc.
 *   2. DELETE the commandId from `commands/pending` via a field-delete.
 *
 * The order matters: completed is written FIRST so that a crash between
 * the two ops leaves the command still in pending (safe to retry),
 * rather than losing it entirely.
 *
 * These helpers mirror that contract from the test side — Playwright
 * specs in D2/D3/D4/D5 will dispatch a UI command, wait for it to land
 * in `commands/pending`, then call `completeCommand(...)` or
 * `failCommand(...)` to simulate the agent finishing its work.
 *
 * Reference: `agent/src/firebase_client.py::_mark_command_completed`.
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from './emulator';

function commandRefs(siteId: string, machineId: string) {
  const db = getAdminDb();
  const machineRef = db.collection('sites').doc(siteId).collection('machines').doc(machineId);
  return {
    completedRef: machineRef.collection('commands').doc('completed'),
    pendingRef: machineRef.collection('commands').doc('pending'),
  };
}

interface CompleteCommandOptions {
  /** Override the status field. Defaults to 'completed'. */
  status?: 'completed' | 'failed';
  /** Set when the command belongs to a deployment (maps to agent's deployment_id). */
  deploymentId?: string;
  /** Command type hint (maps to agent's cmd_type, e.g. 'reboot', 'kill_process'). */
  cmdType?: string;
}

/**
 * Simulate the agent finishing a command successfully.
 *
 * Writes `{ [commandId]: { result, status, completedAt, [deployment_id], [type] } }`
 * to `commands/completed` (merged), then removes `commandId` from
 * `commands/pending` via `FieldValue.delete()` — same order-of-ops as
 * the real agent.
 */
export async function completeCommand(
  siteId: string,
  machineId: string,
  commandId: string,
  result: unknown,
  opts: CompleteCommandOptions = {},
): Promise<void> {
  const { completedRef, pendingRef } = commandRefs(siteId, machineId);

  const payload: Record<string, unknown> = {
    result,
    status: opts.status ?? 'completed',
    completedAt: Timestamp.now(),
  };
  if (opts.deploymentId) payload.deployment_id = opts.deploymentId;
  if (opts.cmdType) payload.type = opts.cmdType;

  // Write to completed FIRST — if this throws, the command stays in
  // pending (safe to retry). Reversing would risk losing it entirely.
  await completedRef.set({ [commandId]: payload }, { merge: true });

  // Remove from pending. Use FieldValue.delete() to match the agent's
  // per-field delete (rather than deleting the whole `pending` doc,
  // which would discard any other in-flight commands).
  await pendingRef.update({ [commandId]: FieldValue.delete() });
}

/**
 * Simulate the agent failing a command.
 *
 * Identical to `completeCommand` but status='failed' and carries an
 * `error` string instead of `result` — mirrors
 * `_mark_command_failed` in firebase_client.py.
 */
export async function failCommand(
  siteId: string,
  machineId: string,
  commandId: string,
  error: string,
  opts: Omit<CompleteCommandOptions, 'status'> = {},
): Promise<void> {
  const { completedRef, pendingRef } = commandRefs(siteId, machineId);

  const payload: Record<string, unknown> = {
    error,
    status: 'failed',
    completedAt: Timestamp.now(),
  };
  if (opts.deploymentId) payload.deployment_id = opts.deploymentId;
  if (opts.cmdType) payload.type = opts.cmdType;

  await completedRef.set({ [commandId]: payload }, { merge: true });
  await pendingRef.update({ [commandId]: FieldValue.delete() });
}

/**
 * Read the current set of pending command IDs for a machine. Useful
 * for specs that dispatch a command and want to grab the generated
 * commandId before stubbing completion.
 */
export async function getPendingCommandIds(
  siteId: string,
  machineId: string,
): Promise<string[]> {
  const { pendingRef } = commandRefs(siteId, machineId);
  const snap = await pendingRef.get();
  if (!snap.exists) return [];
  return Object.keys(snap.data() ?? {});
}
