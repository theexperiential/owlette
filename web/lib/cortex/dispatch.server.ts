/**
 * Cortex autonomous-mode tool dispatcher
 * (security-boundary-migration wave 3.12).
 *
 * The autonomous investigation flow in `/api/cortex/autonomous/route.ts`
 * dispatches tool calls to agents via firestore commands. Until this wave
 * those writes happened directly from the route (no system actor, no audit
 * row, no rate-limit bucket isolation). This module routes every
 * autonomous-dispatched command through `invokeAsSystem` and the
 * canonical `executeMachineCommand` action core so:
 *
 *   - every dispatch produces an `allow` audit entry with
 *     `actor.type === 'system'` and `actor.name === 'cortex_autonomous'`
 *   - cortex burst traffic consumes the system rate-limit bucket only;
 *     human operators on the same site cannot be throttled by an
 *     autonomous reaction firing N tool calls in a tight loop
 *   - the capability matrix (MACHINE_EXEC_COMMAND for cortex_autonomous)
 *     is the single gate — adding new autonomous capabilities means
 *     editing `SystemCapabilityMatrix`, not changing dispatch code
 *   - command writes have the same lifecycle/audit-correlation shape as
 *     the public machine-command route
 *
 * User-mode cortex (`/api/cortex/route.ts` and the chat endpoint) keeps
 * using `executeToolOnAgent` / `executeExistingCommand` from
 * `cortex-utils.server.ts` directly. Those callers are
 * session-authenticated and already pass through `verifyUserSiteAccess`,
 * the per-tool tier ceiling, and the user rate-limit bucket via the http
 * route wrapper. Forcing them through `invokeAsSystem` would
 * misattribute the actor in the audit log (system, not user).
 *
 * The `provision_cortex_key` flow stays on the command channel and is
 * NOT dispatched from this module — see
 * `dev/active/security-boundary-migration/reference/cortex-integration.md`
 * for the canonical-path decision.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { invokeAsSystem, type SystemInvokerContext } from '@/lib/systemInvoker.server';
import { Capability, type SystemActor } from '@/lib/capabilities';
import {
  executeMachineCommand,
  type ExecuteMachineCommandContext,
} from '@/lib/actions/executeMachineCommand.server';
import {
  COMMAND_POLL_INTERVAL_MS,
  COMMAND_TIMEOUT_MS,
} from '@/lib/cortex-utils.server';

/* -------------------------------------------------------------------------- */
/*  types                                                                     */
/* -------------------------------------------------------------------------- */

export interface AutonomousDispatchContext {
  db: FirebaseFirestore.Firestore;
  siteId: string;
  machineId: string;
  /** Cortex investigation chat id — stamped into audit metadata. */
  chatId: string;
  /** Cortex event id (`cortex-events/{eventId}`) — stamped into audit metadata. */
  eventId: string;
}

interface DispatchOutcome {
  /** Optional structured result the LLM consumes. */
  result?: unknown;
  /** Optional error message — surfaced to the LLM as a tool failure. */
  error?: string;
}

/* -------------------------------------------------------------------------- */
/*  helpers                                                                   */
/* -------------------------------------------------------------------------- */

function actorFor(siteId: string): SystemActor {
  return { type: 'system', name: 'cortex_autonomous', siteId };
}

function metadataFor(ctx: AutonomousDispatchContext, extra: Record<string, unknown> = {}) {
  return {
    cortexChatId: ctx.chatId,
    cortexEventId: ctx.eventId,
    ...extra,
  };
}

function actionContextFor(
  ctx: AutonomousDispatchContext,
  systemCtx: SystemInvokerContext,
): ExecuteMachineCommandContext {
  return {
    siteId: systemCtx.siteId,
    machineId: ctx.machineId,
    actor: systemCtx.actor,
    auditActor: `system:${systemCtx.actor.name}`,
    correlationId: systemCtx.correlationId,
  };
}

function pendingRef(db: FirebaseFirestore.Firestore, siteId: string, machineId: string) {
  return db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('commands')
    .doc('pending');
}

function completedRef(db: FirebaseFirestore.Firestore, siteId: string, machineId: string) {
  return db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('commands')
    .doc('completed');
}

/**
 * Poll `commands/completed` for `commandId` until a result arrives or the
 * deadline elapses. Returns `null` on timeout. Best-effort cleanup of the
 * pending entry on timeout — callers do not need to await it.
 *
 * Polling lives outside `invokeAsSystem` deliberately: the privileged
 * action is the WRITE of the pending command. Reading the response is an
 * observation step that the agent already authorized when it processed
 * the command.
 */
async function pollForResult(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineId: string,
  commandId: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  const completed = completedRef(db, siteId, machineId);
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, COMMAND_POLL_INTERVAL_MS));

    const completedDoc = await completed.get();
    if (!completedDoc.exists) continue;

    const data = completedDoc.data();
    const cmdResult = data?.[commandId] as Record<string, unknown> | undefined;
    if (cmdResult) {
      // Best-effort cleanup so the doc doesn't grow unbounded.
      await completed.update({ [commandId]: FieldValue.delete() }).catch(() => undefined);
      return cmdResult;
    }
  }

  // Timeout — try to remove the pending entry too.
  try {
    await pendingRef(db, siteId, machineId).update({
      [commandId]: FieldValue.delete(),
    });
  } catch {
    // Best effort.
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  mcp tool-call dispatch                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Dispatch an MCP tool call (tier 1/2 generic agent tool) for an
 * autonomous investigation. The pending-command write is wrapped in
 * `invokeAsSystem({ capability: MACHINE_EXEC_COMMAND })`; polling for
 * the agent's response runs outside the privileged frame.
 *
 * Mirrors `executeToolOnAgent` from `cortex-utils.server.ts` but with
 * audit + rate-limit + capability mediation.
 */
export async function dispatchToolCallAsSystem(
  ctx: AutonomousDispatchContext,
  toolName: string,
  toolParams: Record<string, unknown>,
): Promise<unknown> {
  const { db, siteId, machineId, chatId } = ctx;

  // Honor any caller-supplied per-tool timeout (mirrors executeToolOnAgent).
  const toolTimeout =
    typeof toolParams.timeout_seconds === 'number'
      ? toolParams.timeout_seconds * 1000
      : COMMAND_TIMEOUT_MS;
  const pollTimeoutMs = toolTimeout + 10_000;

  const queued = await invokeAsSystem({
    actor: actorFor(siteId),
    capability: Capability.MACHINE_EXEC_COMMAND,
    siteId,
    target: { kind: 'machine', id: machineId, machineId },
    metadata: metadataFor(ctx, {
      toolName,
      commandType: 'mcp_tool_call',
    }),
    action: async (systemCtx) =>
      executeMachineCommand(
        actionContextFor(ctx, systemCtx),
        {
          type: 'mcp_tool_call',
          payload: {
            tool_name: toolName,
            tool_params: toolParams,
            chat_id: chatId,
            timeout_seconds: toolTimeout / 1000,
          },
        },
        { db },
      ),
  });

  const { commandId } = queued;
  const cmdResult = await pollForResult(db, siteId, machineId, commandId, pollTimeoutMs);
  return interpretToolCallResult(toolName, cmdResult, pollTimeoutMs);
}

function interpretToolCallResult(
  toolName: string,
  cmdResult: Record<string, unknown> | null,
  pollTimeoutMs: number,
): DispatchOutcome | unknown {
  if (cmdResult === null) {
    return {
      error: `Tool '${toolName}' timed out after ${Math.round(pollTimeoutMs / 1000)} seconds. The machine may be slow to respond or offline.`,
    };
  }

  if (cmdResult.status === 'failed') {
    return { error: (cmdResult.error as string) || 'Tool execution failed' };
  }

  const result = cmdResult.result;
  if (typeof result === 'string') {
    try {
      return JSON.parse(result);
    } catch {
      return { result };
    }
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/*  legacy-typed command dispatch                                             */
/* -------------------------------------------------------------------------- */

/**
 * Dispatch a legacy-typed command (`restart_process`, `kill_process`,
 * `reboot_machine`, etc.) for an autonomous investigation. Same audit +
 * rate-limit semantics as `dispatchToolCallAsSystem`; the only
 * difference is the firestore command shape — these commands carry a
 * `process_name` instead of `tool_name` / `tool_params`.
 *
 * Mirrors `executeExistingCommand` from `cortex-utils.server.ts`.
 */
export async function dispatchExistingCommandAsSystem(
  ctx: AutonomousDispatchContext,
  commandType: string,
  commandParams: Record<string, unknown> | string = {},
): Promise<unknown> {
  const { db, siteId, machineId } = ctx;
  const payload = normalizeExistingCommandPayload(commandParams);
  const processName =
    typeof payload.process_name === 'string' ? payload.process_name : undefined;

  const queued = await invokeAsSystem({
    actor: actorFor(siteId),
    capability: Capability.MACHINE_EXEC_COMMAND,
    siteId,
    target: { kind: 'machine', id: machineId, machineId },
    metadata: metadataFor(ctx, {
      commandType,
      ...(processName ? { processName } : {}),
    }),
    action: async (systemCtx) =>
      executeMachineCommand(
        actionContextFor(ctx, systemCtx),
        {
          type: commandType,
          payload,
        },
        { db },
      ),
  });

  const { commandId } = queued;
  const cmdResult = await pollForResult(db, siteId, machineId, commandId, COMMAND_TIMEOUT_MS);
  if (cmdResult === null) {
    return { error: `Command '${commandType}' timed out` };
  }

  return {
    status: cmdResult.status,
    result: cmdResult.result || cmdResult.error || 'Command completed',
  };
}

function normalizeExistingCommandPayload(
  commandParams: Record<string, unknown> | string,
): Record<string, unknown> {
  if (typeof commandParams === 'string') {
    return commandParams ? { process_name: commandParams } : {};
  }
  if (
    commandParams === null ||
    typeof commandParams !== 'object' ||
    Array.isArray(commandParams)
  ) {
    return {};
  }
  return { ...commandParams };
}
