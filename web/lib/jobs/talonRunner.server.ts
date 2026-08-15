/**
 * Talon command dispatch — the ONLY module that acts as the `talon_runner`
 * system actor (talons wave 2, task 2.1).
 *
 * Every command a talon queues on a machine (a `command` output, or the
 * `capture_screenshot` a `visual_check` condition needs) flows through here so
 * that:
 *
 *   - each dispatch produces an `allow` audit row with `actor.type === 'system'`
 *     and `actor.name === 'talon_runner'`
 *   - talon traffic consumes the *system* rate-limit bucket only, so a burst of
 *     scheduled talons can never throttle the operators working the same site
 *   - `SystemCapabilityMatrix.talon_runner` (exactly `MACHINE_EXEC_COMMAND`) is
 *     the single gate — widening what a talon may do means editing the matrix,
 *     not this file
 *
 * **Why this lives under `web/lib/jobs/`.** `invokeAsSystem` may only be
 * imported from `web/lib/hoot/**`, `web/lib/jobs/**`, or tests — enforced by
 * the `no-restricted-imports` eslint rule in `web/eslint.config.mjs` and again
 * at ci time by `scripts/check-system-invoker-callers.mjs`. The talon engine,
 * its output executors, and the visual-check evaluator all live under
 * `web/lib/talons/` and call into this module rather than importing the invoker
 * themselves, which keeps the allowlist a boundary rather than a formality.
 *
 * Modelled on `@/lib/hoot/dispatch.server` — same privileged-write /
 * unprivileged-poll split, same non-terminal `running` marker handling.
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { invokeAsSystem, type SystemInvokerContext } from '@/lib/systemInvoker.server';
import { Capability, type SystemActor } from '@/lib/capabilities';
import {
  executeMachineCommand,
  type ExecuteMachineCommandContext,
} from '@/lib/actions/executeMachineCommand.server';
import {
  COMMAND_POLL_INTERVAL_MS,
  COMMAND_TIMEOUT_MS,
} from '@/lib/hoot-utils.server';

/* -------------------------------------------------------------------------- */
/*  types                                                                     */
/* -------------------------------------------------------------------------- */

export interface TalonDispatchInput {
  siteId: string;
  machineId: string;
  /** Agent command type — must be in `ALLOWED_COMMAND_TYPES`. */
  type: string;
  /** Per-type command fields, merged into the firestore command envelope. */
  payload: Record<string, unknown>;
  /**
   * The run's `correlationId` (`talon_runs/{runId}.correlationId`). Stamped
   * into audit metadata as `talonCorrelationId` so an investigator can pivot
   * run → audit row → command. The command envelope itself keeps carrying the
   * *invoker's* correlation id, which is the id of the audit row that
   * authorized it — the same invariant every other `executeMachineCommand`
   * caller maintains.
   */
  correlationId: string;
}

/**
 * A terminal `commands/completed` entry, or the fact that the poll deadline
 * elapsed first. `timeout` is not an error: the command may still be running
 * on the machine, and the caller decides what that means for its output.
 */
export type TalonCommandOutcome =
  | { status: 'completed'; commandId: string; entry: Record<string, unknown> }
  | { status: 'timeout'; commandId: string };

export interface DispatchAndAwaitOptions {
  /**
   * Poll budget. Defaults to the shared 30s agent command timeout; the
   * screenshot capture a visual check needs passes 45s because the capture
   * has to round-trip through the user desktop session and GCS.
   */
  timeoutMs?: number;
}

/* -------------------------------------------------------------------------- */
/*  helpers                                                                   */
/* -------------------------------------------------------------------------- */

function actorFor(siteId: string): SystemActor {
  return { type: 'system', name: 'talon_runner', siteId };
}

function actionContextFor(
  machineId: string,
  systemCtx: SystemInvokerContext,
): ExecuteMachineCommandContext {
  return {
    siteId: systemCtx.siteId,
    machineId,
    actor: systemCtx.actor,
    auditActor: `system:${systemCtx.actor.name}`,
    correlationId: systemCtx.correlationId,
  };
}

function commandsCollection(db: Firestore, siteId: string, machineId: string) {
  return db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('commands');
}

/* -------------------------------------------------------------------------- */
/*  dispatch                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Queue one command on a machine as the `talon_runner` system actor.
 *
 * Throws whatever the pipeline throws: `SystemInvoker*` errors when the
 * capability, rate limit, or audit write refuses, and
 * `ExecuteMachineCommandError` from the action core — notably a 409
 * `machine_offline` when the target is down. Callers classify; this function
 * does not swallow.
 *
 * @returns the firestore command id, for polling.
 */
export async function dispatchTalonCommand(
  db: Firestore,
  input: TalonDispatchInput,
): Promise<{ commandId: string }> {
  const { siteId, machineId, type, payload, correlationId } = input;

  return invokeAsSystem({
    actor: actorFor(siteId),
    capability: Capability.MACHINE_EXEC_COMMAND,
    siteId,
    target: { kind: 'machine', id: machineId, machineId },
    metadata: {
      talonCorrelationId: correlationId,
      commandType: type,
    },
    action: async (systemCtx) =>
      executeMachineCommand(
        actionContextFor(machineId, systemCtx),
        { type, payload },
        { db },
      ),
  });
}

/**
 * Poll `commands/completed` for `commandId` until a TERMINAL entry arrives or
 * the deadline elapses. Returns `null` on timeout, after a best-effort attempt
 * to remove the orphaned pending entry.
 *
 * Polling deliberately runs OUTSIDE the `invokeAsSystem` frame: the privileged
 * act is writing the pending command. Reading the machine's reply is an
 * observation the agent already authorized by processing that command.
 *
 * CROSS-SIDE CONTRACT: the agent writes `{status: 'running', startedAt}` when a
 * command starts (restart safety + progress signal — see
 * `agent/src/firebase_client.py` `_mark_command_running`). Running entries are
 * NON-terminal: skip them and keep polling, and never delete them — the agent's
 * terminal write overwrites the marker. Mirrors `pollForResult` in
 * `@/lib/hoot/dispatch.server` and `hoot-utils.server.ts`.
 */
export async function pollTalonCommandResult(
  db: Firestore,
  siteId: string,
  machineId: string,
  commandId: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  const commands = commandsCollection(db, siteId, machineId);
  const completed = commands.doc('completed');
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, COMMAND_POLL_INTERVAL_MS));

    const completedDoc = await completed.get();
    if (!completedDoc.exists) continue;

    const data = completedDoc.data();
    const cmdResult = data?.[commandId] as Record<string, unknown> | undefined;
    if (cmdResult) {
      if (cmdResult.status === 'running') continue;

      // Best-effort cleanup so the doc doesn't grow unbounded.
      await completed.update({ [commandId]: FieldValue.delete() }).catch(() => undefined);
      return cmdResult;
    }
  }

  // Timeout — try to remove the pending entry too.
  try {
    await commands.doc('pending').update({ [commandId]: FieldValue.delete() });
  } catch {
    // Best effort.
  }
  return null;
}

/**
 * Dispatch a command and wait for the machine's terminal reply.
 *
 * The convenience the talon executors actually use — every talon command is
 * synchronous from the run's point of view, because the run's status depends on
 * what the machine said.
 */
export async function dispatchAndAwait(
  db: Firestore,
  input: TalonDispatchInput,
  options: DispatchAndAwaitOptions = {},
): Promise<TalonCommandOutcome> {
  const { commandId } = await dispatchTalonCommand(db, input);
  const entry = await pollTalonCommandResult(
    db,
    input.siteId,
    input.machineId,
    commandId,
    options.timeoutMs ?? COMMAND_TIMEOUT_MS,
  );
  return entry === null
    ? { status: 'timeout', commandId }
    : { status: 'completed', commandId, entry };
}
