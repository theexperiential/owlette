/**
 * History repair for Hoot UIMessages.
 *
 * A stream that dies mid-tool-call (proxy idle timeout, page reload, network drop)
 * leaves the tool part in an `input-*` state — a tool call with no output.
 * `convertToModelMessages` throws `MissingToolResultsError` on such history, which
 * permanently bricks the conversation: every retry replays the same broken messages.
 *
 * `repairDanglingToolParts` rewrites those parts to a terminal `output-error` so the
 * model sees an honest "result lost" outcome and the chat continues. Unanswered
 * tier-3 approval requests superseded by a later user message resolve the same way
 * (the tool never executed).
 *
 * With a `resolveLostResult` resolver (async overload), dangling `input-*` parts get
 * a recovery attempt first: the agent writes tool results to `commands/completed`
 * whether or not the web turn survived. `{ output }` splices the genuine result in as
 * `output-available`, `{ errorText }` customizes the error (e.g. STILL_RUNNING_ERROR
 * while the command is executing), `null` falls back to LOST_RESULT_ERROR. Superseded
 * `approval-requested` parts never consult the resolver — nothing was dispatched.
 *
 * Only assistant turns already superseded by a later user message are touched; the
 * final assistant message may legitimately be mid-flight and passes through.
 */

import type { UIMessage } from 'ai';

type UIMessagePart = UIMessage['parts'][number];

interface ToolLikePart {
  type: string;
  state: string;
  toolCallId: string;
  input?: unknown;
}

export const LOST_RESULT_ERROR =
  'result lost: the connection dropped before the tool result arrived. ' +
  'The command may still have completed on the machine — re-run the tool or verify if needed.';

export const SUPERSEDED_APPROVAL_ERROR =
  'approval request superseded: the user sent a new message before approving or denying, ' +
  'so the tool was never executed. Ask again if it is still needed.';

export const APPROVAL_ALREADY_CONSUMED_ERROR =
  'approval already consumed: another turn (a reload or second tab) already resumed this ' +
  'approval and dispatched the tool. Do not run it again — check that turn for the result, ' +
  'or verify the effect on the machine.';

export const LATE_DENIAL_ERROR =
  'denial arrived too late: an earlier turn had already consumed this approval and ' +
  'dispatched the tool, so the denial could not stop it. Verify the effect on the machine ' +
  'if needed.';

/**
 * Passed as `{ errorText: STILL_RUNNING_ERROR }` when the command's completed-doc
 * entry shows `status:'running'` — the honest state is "in progress", not "lost".
 */
export const STILL_RUNNING_ERROR =
  'tool is still running on the machine — the result will be recovered when it completes';

function isToolPart(part: UIMessagePart): part is UIMessagePart & ToolLikePart {
  return (
    typeof part === 'object' &&
    part !== null &&
    'state' in part &&
    (part.type === 'dynamic-tool' || part.type.startsWith('tool-'))
  );
}

/** True when a tool part's approval was granted (`approval-responded`, approved). */
function isApprovalApproved(part: UIMessagePart & ToolLikePart): boolean {
  return (part as { approval?: { approved?: boolean } }).approval?.approved === true;
}

/**
 * Convert a dangling tool part to `output-error`, preserving identity fields
 * (`type`, `toolCallId`, `toolName`) and the captured input. A pending `approval` is
 * dropped — an unresolved `tool-approval-request` must not reach the model beside it.
 */
function toErrorPart(part: UIMessagePart & ToolLikePart, errorText: string): UIMessagePart {
  const { approval: _approval, output: _output, ...rest } = part as ToolLikePart & {
    approval?: unknown;
    output?: unknown;
  };
  return {
    ...rest,
    state: 'output-error',
    input: part.input ?? {},
    errorText,
  } as UIMessagePart;
}

/**
 * Convert a dangling tool part to `output-available` with a recovered real output.
 * Same identity-preserving shape as `toErrorPart`; pending `approval` dropped too.
 */
function toOutputPart(part: UIMessagePart & ToolLikePart, output: unknown): UIMessagePart {
  const { approval: _approval, output: _output, ...rest } = part as ToolLikePart & {
    approval?: unknown;
    output?: unknown;
  };
  return {
    ...rest,
    state: 'output-available',
    input: part.input ?? {},
    output,
  } as UIMessagePart;
}

export interface RepairResult {
  messages: UIMessage[];
  /** Tool call ids that were rewritten — empty when the history was clean. */
  repairedToolCallIds: string[];
}

/** A recovered real output, a custom error text, or `null` for "nothing found". */
export type LostResultResolution = { output: unknown } | { errorText: string };

export interface RepairOptions {
  /**
   * Recovery lookup for a dangling tool call (typically the `commands/completed`
   * doc). Only consulted for `input-streaming` / `input-available` parts, never for
   * superseded `approval-requested` parts, whose tool was never dispatched.
   */
  resolveLostResult: (toolCallId: string) => Promise<LostResultResolution | null>;
}

/** Last index whose role is 'user'; assistant turns after it are in flight. */
function findLastUserIndex(messages: UIMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i;
  }
  return -1;
}

/**
 * Single repair pass shared by both overloads. `resolutions` holds recovered outcomes
 * by tool call id (always empty on the sync path); the rest fall back to the errors.
 */
function applyRepairs(
  messages: UIMessage[],
  resolutions: ReadonlyMap<string, LostResultResolution>,
): RepairResult {
  const repairedToolCallIds: string[] = [];
  const lastUserIndex = findLastUserIndex(messages);

  const repaired = messages.map((message, index) => {
    // Assistant turns after the last user message are still in flight
    // (e.g. awaiting an approval response) — leave them untouched.
    if (message.role !== 'assistant' || index > lastUserIndex) return message;

    let changed = false;
    const parts = message.parts.map((part) => {
      if (!isToolPart(part)) return part;

      // Terminal states already carry a result/error. Anything else is dangling and
      // must get a synthetic one, or convertToModelMessages emits a `tool_use` with
      // no matching `tool_result` and the provider rejects the whole request.
      if (part.state === 'output-available' || part.state === 'output-error') {
        return part;
      }

      // A DENIED approval is self-contained — convertToModelMessages feeds the denial
      // back to the model without a tool_result. Only APPROVED-but-outputless dangles.
      if (part.state === 'approval-responded' && !isApprovalApproved(part)) {
        return part;
      }

      changed = true;
      repairedToolCallIds.push(part.toolCallId);

      // `approval-requested` was never dispatched (the tool never ran), so
      // there is nothing to recover — synthesize the superseded-approval error.
      if (part.state === 'approval-requested') {
        return toErrorPart(part, SUPERSEDED_APPROVAL_ERROR);
      }

      // Any other non-terminal state — `input-streaming`, `input-available`, or an
      // APPROVED `approval-responded` — was dispatched to the agent, so the real
      // result may exist in `commands/completed`. Recover it, else synthesize the error.
      const resolution = resolutions.get(part.toolCallId);
      if (resolution && 'output' in resolution) {
        return toOutputPart(part, resolution.output);
      }
      return toErrorPart(part, resolution?.errorText ?? LOST_RESULT_ERROR);
    });

    return changed ? { ...message, parts } : message;
  });

  return { messages: repaired, repairedToolCallIds };
}

/**
 * Tool call ids of resolver-eligible dangling parts on superseded assistant turns, in
 * history order: any non-terminal state EXCEPT `approval-requested` (never
 * dispatched). Mirrors `applyRepairs`, including `approval-responded`, so a tier-3
 * tool approved and superseded mid-execution still recovers its real result.
 */
function collectResolverEligibleIds(messages: UIMessage[]): string[] {
  const ids: string[] = [];
  const lastUserIndex = findLastUserIndex(messages);

  messages.forEach((message, index) => {
    if (message.role !== 'assistant' || index > lastUserIndex) return;
    for (const part of message.parts) {
      if (
        isToolPart(part) &&
        part.state !== 'output-available' &&
        part.state !== 'output-error' &&
        part.state !== 'approval-requested' &&
        !(part.state === 'approval-responded' && !isApprovalApproved(part))
      ) {
        ids.push(part.toolCallId);
      }
    }
  });

  return ids;
}

export interface ApprovalConsumptionOptions {
  /**
   * Atomic one-shot claim for a tool call's approval (approvalLedger.server.ts
   * on the server; injectable for tests). 'claimed' → this turn owns the
   * dispatch; 'already-consumed' → another turn got there first.
   */
  claim: (toolCallId: string) => Promise<'claimed' | 'already-consumed'>;
  /** Same recovery lookup as RepairOptions — consulted for consumed approvals. */
  resolveLostResult: (toolCallId: string) => Promise<LostResultResolution | null>;
}

export interface ApprovalConsumptionResult {
  messages: UIMessage[];
  /** Rewritten replacement parts by tool call id — empty when nothing was consumed. */
  consumedParts: Map<string, UIMessagePart>;
}

/**
 * One-shot enforcement for tier-3 approvals on the IN-FLIGHT assistant segment
 * (the messages `applyRepairs` deliberately skips: index > last user message).
 *
 * An `approval-responded` part there is what this turn is about to act on:
 * - approved + claim 'claimed' → left untouched; this turn owns the dispatch.
 * - approved + claim 'already-consumed' → a duplicate resume (reload, second
 *   tab, double-send): recover the real result via `resolveLostResult`, else
 *   rewrite to `APPROVAL_ALREADY_CONSUMED_ERROR` — the SDK then sees a
 *   terminal part and never re-executes the tool.
 * - denied + claim 'already-consumed' → the denial lost the race to a turn
 *   that already dispatched: rewrite to `LATE_DENIAL_ERROR` so the model is
 *   not told the tool was stopped when it wasn't.
 * - denied + claim 'claimed' → normal denial, left untouched (self-contained).
 *
 * Callers should apply this AFTER `repairDanglingToolParts` and persist the
 * resulting array, and re-apply `consumedParts` to the SDK's final merged
 * message (which is seeded from the raw history) before the final persist.
 */
export async function applyApprovalConsumption(
  messages: UIMessage[],
  opts: ApprovalConsumptionOptions,
): Promise<ApprovalConsumptionResult> {
  const consumedParts = new Map<string, UIMessagePart>();
  const lastUserIndex = findLastUserIndex(messages);

  const result: UIMessage[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== 'assistant' || index <= lastUserIndex) {
      result.push(message);
      continue;
    }

    let changed = false;
    const parts: UIMessagePart[] = [];
    for (const part of message.parts) {
      if (!isToolPart(part) || part.state !== 'approval-responded') {
        parts.push(part);
        continue;
      }

      const claim = await opts.claim(part.toolCallId);
      if (claim === 'claimed') {
        parts.push(part);
        continue;
      }

      changed = true;
      let replacement: UIMessagePart;
      if (isApprovalApproved(part)) {
        const resolution = await opts.resolveLostResult(part.toolCallId);
        replacement =
          resolution && 'output' in resolution
            ? toOutputPart(part, resolution.output)
            : toErrorPart(part, resolution?.errorText ?? APPROVAL_ALREADY_CONSUMED_ERROR);
      } else {
        replacement = toErrorPart(part, LATE_DENIAL_ERROR);
      }
      consumedParts.set(part.toolCallId, replacement);
      parts.push(replacement);
    }

    result.push(changed ? { ...message, parts } : message);
  }

  return { messages: result, consumedParts };
}

/**
 * Re-apply consumption outcomes to a message array whose trailing assistant
 * message came from the SDK (seeded from the RAW history, so a consumed part
 * can resurface as `approval-responded`). Only non-terminal occurrences are
 * replaced — a part the SDK finished for real is left alone.
 */
export function reapplyConsumedParts(
  messages: UIMessage[],
  consumedParts: ReadonlyMap<string, UIMessagePart>,
): UIMessage[] {
  if (consumedParts.size === 0) return messages;
  return messages.map((message) => {
    if (message.role !== 'assistant') return message;
    let changed = false;
    const parts = message.parts.map((part) => {
      if (
        isToolPart(part) &&
        part.state === 'approval-responded' &&
        consumedParts.has(part.toolCallId)
      ) {
        changed = true;
        return consumedParts.get(part.toolCallId)!;
      }
      return part;
    });
    return changed ? { ...message, parts } : message;
  });
}

export function repairDanglingToolParts(messages: UIMessage[]): RepairResult;
export function repairDanglingToolParts(
  messages: UIMessage[],
  opts: RepairOptions,
): Promise<RepairResult>;
export function repairDanglingToolParts(
  messages: UIMessage[],
  opts?: RepairOptions,
): RepairResult | Promise<RepairResult> {
  if (!opts) return applyRepairs(messages, new Map());

  return (async () => {
    const resolutions = new Map<string, LostResultResolution>();
    for (const toolCallId of collectResolverEligibleIds(messages)) {
      if (resolutions.has(toolCallId)) continue;
      const resolution = await opts.resolveLostResult(toolCallId);
      if (resolution) resolutions.set(toolCallId, resolution);
    }
    return applyRepairs(messages, resolutions);
  })();
}
