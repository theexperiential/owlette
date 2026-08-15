/**
 * History repair for Hoot UIMessages.
 *
 * When a chat stream dies mid-tool-call (proxy idle timeout, page reload,
 * network drop), the persisted history keeps the tool part in an `input-*`
 * state — a tool call with no output. `convertToModelMessages` throws
 * `MissingToolResultsError` on such history, which permanently bricks the
 * conversation: every subsequent send (and every retry) replays the same
 * broken messages and fails identically.
 *
 * `repairDanglingToolParts` rewrites those parts to a terminal `output-error`
 * state so the model sees an honest "result lost" outcome and the chat can
 * continue. Unanswered tier-3 approval requests that were superseded by a
 * later user message are resolved the same way (the tool never executed).
 *
 * When a `resolveLostResult` resolver is supplied (async overload), dangling
 * `input-streaming`/`input-available` parts get a recovery attempt first: the
 * agent writes tool results to `commands/completed` regardless of whether the
 * web turn survived, so the real output may exist even though the stream died.
 * The resolver looks it up by tool call id — `{ output }` splices the genuine
 * result in as `output-available`, `{ errorText }` customizes the error (e.g.
 * `STILL_RUNNING_ERROR` while the command is still executing), and `null`
 * falls back to the synthesized `LOST_RESULT_ERROR`. Superseded
 * `approval-requested` parts never consult the resolver — the tool was never
 * dispatched, so there is nothing to recover.
 *
 * Only assistant turns already superseded by a later user message are
 * touched — the final assistant message may legitimately be mid-flight
 * (an approval round-trip about to resume) and passes through untouched.
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

/**
 * Passed by callers as `{ errorText: STILL_RUNNING_ERROR }` when the
 * command's completed-doc entry shows `status:'running'` — the honest state
 * is "in progress", not "lost".
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
 * (`type`, `toolCallId`, and `toolName` for dynamic-tool parts) and the
 * captured input. Any pending `approval` is dropped — an unresolved
 * `tool-approval-request` must not reach the model alongside the error result.
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
 * Convert a dangling tool part to `output-available` with a recovered real
 * output. Same identity-preserving shape as `toErrorPart` (any pending
 * `approval` is dropped for the same reason).
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
   * Recovery lookup for a dangling tool call (typically against the
   * `commands/completed` doc). Only consulted for `input-streaming` /
   * `input-available` parts — never for superseded `approval-requested`
   * parts, whose tool was never dispatched.
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
 * Single repair pass shared by both overloads. `resolutions` carries any
 * recovered outcomes keyed by tool call id (always empty on the sync path);
 * dangling parts without an entry fall back to the synthesized errors.
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

      // Terminal states already carry a result/error — leave them untouched.
      // Everything else is dangling and must be given a synthetic result, or
      // convertToModelMessages emits a `tool_use` with no matching
      // `tool_result` and the provider rejects the whole request.
      if (part.state === 'output-available' || part.state === 'output-error') {
        return part;
      }

      // A DENIED approval (`approval-responded`, approved === false) is
      // self-contained: convertToModelMessages feeds the denial back to the
      // model without needing a tool_result. Leave it untouched — only an
      // APPROVED-but-outputless part is actually dangling.
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

      // Any other non-terminal state — `input-streaming`, `input-available`,
      // or an APPROVED `approval-responded` (a tier-3 tool approved and
      // dispatched but whose output never came back) — was dispatched to the
      // agent, so the real result may exist in `commands/completed`. Recover it
      // if the resolver found it, else synthesize the lost-result error.
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
 * Tool call ids of resolver-eligible dangling parts on superseded assistant
 * turns, in history order. Eligible = dispatched to the agent but without a
 * terminal result: any non-terminal state EXCEPT `approval-requested` (which
 * was never dispatched). This mirrors `applyRepairs` — including
 * `approval-responded`, so a tier-3 tool approved and superseded mid-execution
 * still gets its real result recovered.
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
