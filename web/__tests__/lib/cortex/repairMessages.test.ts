/**
 * @jest-environment node
 *
 * Tests for the Cortex history repair (repairDanglingToolParts).
 *
 * Pins down:
 *   1. clean histories pass through untouched (same references)
 *   2. dangling `input-available` / `input-streaming` tool parts on a
 *      superseded assistant turn become terminal `output-error` parts
 *   3. unanswered `approval-requested` parts superseded by a later user
 *      message are resolved (approval stripped, error output)
 *   4. the final in-flight assistant message is never touched (the tier-3
 *      approval round-trip depends on it)
 *   5. regression pin against the real AI SDK: the broken shape makes
 *      convertToModelMessages throw MissingToolResultsError; the repaired
 *      shape converts cleanly
 */

import { convertToModelMessages, streamText, type UIMessage } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import {
  repairDanglingToolParts,
  LOST_RESULT_ERROR,
  SUPERSEDED_APPROVAL_ERROR,
} from '@/lib/cortex/repairMessages';

function userMsg(id: string, text: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] } as UIMessage;
}

function assistantMsg(id: string, parts: unknown[]): UIMessage {
  return { id, role: 'assistant', parts } as UIMessage;
}

const danglingToolPart = {
  type: 'tool-execute_script',
  toolCallId: 'toolu_dangling_1',
  state: 'input-available',
  input: { script: 'sfc /scannow', timeout_seconds: 1800 },
};

const completedToolPart = {
  type: 'tool-execute_script',
  toolCallId: 'toolu_done_1',
  state: 'output-available',
  input: { script: 'Get-Date' },
  output: { exit_code: 0, stdout: 'ok' },
};

describe('repairDanglingToolParts', () => {
  it('returns clean histories untouched (same message references)', () => {
    const messages = [
      userMsg('u1', 'run a script'),
      assistantMsg('a1', [{ type: 'text', text: 'done' }, completedToolPart]),
      userMsg('u2', 'thanks'),
    ];

    const { messages: out, repairedToolCallIds } = repairDanglingToolParts(messages);

    expect(repairedToolCallIds).toEqual([]);
    expect(out[1]).toBe(messages[1]);
  });

  it('repairs a dangling input-available part on a superseded turn', () => {
    const messages = [
      userMsg('u1', 'run sfc and dism'),
      assistantMsg('a1', [{ type: 'text', text: 'running both' }, completedToolPart, danglingToolPart]),
      userMsg('u2', 'still running?'),
    ];

    const { messages: out, repairedToolCallIds } = repairDanglingToolParts(messages);

    expect(repairedToolCallIds).toEqual(['toolu_dangling_1']);
    const parts = out[1].parts as Array<Record<string, unknown>>;
    expect(parts[1]).toBe(completedToolPart); // untouched sibling
    expect(parts[2]).toMatchObject({
      type: 'tool-execute_script',
      toolCallId: 'toolu_dangling_1',
      state: 'output-error',
      errorText: LOST_RESULT_ERROR,
      input: danglingToolPart.input, // captured input preserved
    });
  });

  it('repairs input-streaming parts and defaults missing input to {}', () => {
    const messages = [
      userMsg('u1', 'go'),
      assistantMsg('a1', [
        { type: 'tool-execute_script', toolCallId: 'toolu_stream_1', state: 'input-streaming' },
      ]),
      userMsg('u2', 'hello?'),
    ];

    const { messages: out, repairedToolCallIds } = repairDanglingToolParts(messages);

    expect(repairedToolCallIds).toEqual(['toolu_stream_1']);
    expect((out[1].parts as Array<Record<string, unknown>>)[0]).toMatchObject({
      state: 'output-error',
      errorText: LOST_RESULT_ERROR,
      input: {},
    });
  });

  it('resolves an unanswered approval superseded by a later user message', () => {
    const messages = [
      userMsg('u1', 'reboot it'),
      assistantMsg('a1', [
        {
          type: 'tool-reboot_machine',
          toolCallId: 'toolu_approval_1',
          state: 'approval-requested',
          input: {},
          approval: { id: 'appr_1' },
        },
      ]),
      userMsg('u2', 'actually, wait'),
    ];

    const { messages: out, repairedToolCallIds } = repairDanglingToolParts(messages);

    expect(repairedToolCallIds).toEqual(['toolu_approval_1']);
    const part = (out[1].parts as Array<Record<string, unknown>>)[0];
    expect(part).toMatchObject({ state: 'output-error', errorText: SUPERSEDED_APPROVAL_ERROR });
    expect(part.approval).toBeUndefined();
  });

  it('never touches the final in-flight assistant message (approval round-trip)', () => {
    const pendingApproval = assistantMsg('a1', [
      {
        type: 'tool-reboot_machine',
        toolCallId: 'toolu_pending_1',
        state: 'approval-requested',
        input: {},
        approval: { id: 'appr_1' },
      },
    ]);
    const messages = [userMsg('u1', 'reboot it'), pendingApproval];

    const { messages: out, repairedToolCallIds } = repairDanglingToolParts(messages);

    expect(repairedToolCallIds).toEqual([]);
    expect(out[1]).toBe(pendingApproval);
  });

  it('preserves toolName on repaired dynamic-tool parts', () => {
    const messages = [
      userMsg('u1', 'go'),
      assistantMsg('a1', [
        {
          type: 'dynamic-tool',
          toolName: 'execute_script',
          toolCallId: 'toolu_dyn_1',
          state: 'input-available',
          input: { script: 'dir' },
        },
      ]),
      userMsg('u2', 'and?'),
    ];

    const { messages: out } = repairDanglingToolParts(messages);

    expect((out[1].parts as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'dynamic-tool',
      toolName: 'execute_script',
      state: 'output-error',
    });
  });

  it('leaves output-error and approval-responded parts untouched', () => {
    const erroredPart = {
      type: 'tool-execute_script',
      toolCallId: 'toolu_err_1',
      state: 'output-error',
      input: {},
      errorText: 'agent said no',
    };
    const respondedPart = {
      type: 'tool-reboot_machine',
      toolCallId: 'toolu_resp_1',
      state: 'approval-responded',
      input: {},
      approval: { id: 'appr_2', approved: false, reason: 'denied' },
    };
    const messages = [
      userMsg('u1', 'go'),
      assistantMsg('a1', [erroredPart, respondedPart]),
      userMsg('u2', 'ok'),
    ];

    const { messages: out, repairedToolCallIds } = repairDanglingToolParts(messages);

    expect(repairedToolCallIds).toEqual([]);
    expect(out[1]).toBe(messages[1]);
  });

  // The regression pin this module exists for: the exact prod failure shape
  // (dangling tool call followed by user messages) makes streamText's prompt
  // preparation throw MissingToolResultsError ("Tool result is missing for
  // tool call toolu_…"); the repaired history streams cleanly. Note the throw
  // happens inside streamText (convertToLanguageModelPrompt), NOT in
  // convertToModelMessages — so the pin must exercise streamText itself.
  it('unbricks streamText for the prod failure shape', async () => {
    const broken = [
      userMsg('u1', 'run sfc /scannow and DISM in parallel'),
      assistantMsg('a1', [
        { type: 'text', text: "I'll run both." },
        completedToolPart,
        danglingToolPart,
      ]),
      userMsg('u2', 'looks like one is still running, right?'),
      userMsg('u3', 'still running?'),
    ];

    async function streamErrors(messages: UIMessage[]): Promise<unknown[]> {
      const errors: unknown[] = [];
      const result = streamText({
        model: new MockLanguageModelV3({
          doStream: async () => ({
            stream: simulateReadableStream({
              chunks: [
                { type: 'text-start', id: 't1' },
                { type: 'text-delta', id: 't1', delta: 'ok' },
                { type: 'text-end', id: 't1' },
                {
                  type: 'finish',
                  finishReason: 'stop',
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                },
              ],
            }),
          }),
        }),
        messages: await convertToModelMessages(messages),
        onError: ({ error }) => {
          errors.push(error);
        },
      });
      await result.consumeStream();
      return errors;
    }

    const brokenErrors = await streamErrors(broken);
    expect(brokenErrors.some((e) => /missing for tool call.*toolu_dangling_1/.test(String(e)))).toBe(
      true,
    );

    const { messages: repaired } = repairDanglingToolParts(broken);
    const repairedErrors = await streamErrors(repaired);
    expect(repairedErrors).toEqual([]);

    // The dangling call now has a matching error tool-result in the model
    // messages, which is what satisfies the SDK's validation.
    const modelMessages = await convertToModelMessages(repaired);
    const toolResults = modelMessages
      .filter((m) => m.role === 'tool')
      .flatMap((m) => m.content as Array<{ type: string; toolCallId?: string }>);
    expect(toolResults.some((c) => c.toolCallId === 'toolu_dangling_1')).toBe(true);
  });
});
