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

// ---------------------------------------------------------------------------
// D1.2 — convenience helpers for state-mutation stubs
//
// Some agent behaviors aren't tied to a specific command doc — they're
// observable only as changes to the machine's status fields. Two common ones:
//   - a scheduled reboot completes (agent clears `rebooting` / `rebootScheduledAt`)
//   - a screenshot capture lands (agent writes `lastScreenshot` with the
//     Storage URL + size + timestamp)
//
// These stubs mutate the machine doc directly. They complement
// completeCommand/failCommand: a reboot flow typically involves BOTH a
// dispatched command (completeCommand) AND a status-field clear
// (stubRebootSuccess) — spec code calls whichever subset it needs.
// ---------------------------------------------------------------------------

function machineRef(siteId: string, machineId: string) {
  return getAdminDb().collection('sites').doc(siteId).collection('machines').doc(machineId);
}

/**
 * Simulate the agent finishing a reboot cycle.
 *
 * Mirrors the agent's post-reboot clear at
 * `agent/src/owlette_service.py:4260` — clears the three reboot-state
 * flags on the machine doc so dashboard listeners flip the "rebooting"
 * pill back to a stable online state.
 */
export async function stubRebootSuccess(siteId: string, machineId: string): Promise<void> {
  await machineRef(siteId, machineId).set(
    {
      rebooting: false,
      rebootScheduledAt: null,
      rebootCancellable: false,
    },
    { merge: true },
  );
}

/**
 * Simulate a screenshot capture arriving on the machine doc.
 *
 * Mirrors the `lastScreenshot` field consumed by `useFirestore.ts:273`
 * — `{ url, timestamp, sizeKB }` — which the machine card + chart
 * components read to render the latest captured frame.
 */
export async function stubScreenshotCapture(
  siteId: string,
  machineId: string,
  url: string,
  sizeKB = 128,
): Promise<void> {
  await machineRef(siteId, machineId).set(
    {
      lastScreenshot: {
        url,
        // Tests use Timestamp.now() rather than FieldValue.serverTimestamp()
        // because the emulator's clock is trusted and specs often want to
        // assert on the written value immediately (serverTimestamp()
        // resolves AFTER the set() resolves, introducing a readback race).
        timestamp: Timestamp.now(),
        sizeKB,
      },
    },
    { merge: true },
  );
}
