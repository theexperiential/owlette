/**
 * History repair for Cortex UIMessages.
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

function isToolPart(part: UIMessagePart): part is UIMessagePart & ToolLikePart {
  return (
    typeof part === 'object' &&
    part !== null &&
    'state' in part &&
    (part.type === 'dynamic-tool' || part.type.startsWith('tool-'))
  );
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

export interface RepairResult {
  messages: UIMessage[];
  /** Tool call ids that were rewritten — empty when the history was clean. */
  repairedToolCallIds: string[];
}

export function repairDanglingToolParts(messages: UIMessage[]): RepairResult {
  const repairedToolCallIds: string[] = [];

  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIndex = i;
      break;
    }
  }

  const repaired = messages.map((message, index) => {
    // Assistant turns after the last user message are still in flight
    // (e.g. awaiting an approval response) — leave them untouched.
    if (message.role !== 'assistant' || index > lastUserIndex) return message;

    let changed = false;
    const parts = message.parts.map((part) => {
      if (!isToolPart(part)) return part;

      if (part.state === 'input-streaming' || part.state === 'input-available') {
        changed = true;
        repairedToolCallIds.push(part.toolCallId);
        return toErrorPart(part, LOST_RESULT_ERROR);
      }
      if (part.state === 'approval-requested') {
        changed = true;
        repairedToolCallIds.push(part.toolCallId);
        return toErrorPart(part, SUPERSEDED_APPROVAL_ERROR);
      }
      return part;
    });

    return changed ? { ...message, parts } : message;
  });

  return { messages: repaired, repairedToolCallIds };
}
