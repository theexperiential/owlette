/**
 * @jest-environment node
 *
 * Tests for the Hoot history repair (repairDanglingToolParts).
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
 *   6. the async resolver overload: recovered `{ output }` becomes a real
 *      `output-available` part, `{ errorText }` customizes the error,
 *      `null` falls back to LOST_RESULT_ERROR, and approval-requested
 *      parts never consult the resolver
 */

import { convertToModelMessages, streamText, type UIMessage } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import {
  repairDanglingToolParts,
  LOST_RESULT_ERROR,
  SUPERSEDED_APPROVAL_ERROR,
  STILL_RUNNING_ERROR,
} from '@/lib/hoot/repairMessages';

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

  it('leaves output-error and DENIED approval-responded parts untouched', () => {
    const erroredPart = {
      type: 'tool-execute_script',
      toolCallId: 'toolu_err_1',
      state: 'output-error',
      input: {},
      errorText: 'agent said no',
    };
    const deniedPart = {
      type: 'tool-reboot_machine',
      toolCallId: 'toolu_resp_1',
      state: 'approval-responded',
      input: {},
      approval: { id: 'appr_2', approved: false, reason: 'denied' },
    };
    const messages = [
      userMsg('u1', 'go'),
      assistantMsg('a1', [erroredPart, deniedPart]),
      userMsg('u2', 'ok'),
    ];

    const { messages: out, repairedToolCallIds } = repairDanglingToolParts(messages);

    expect(repairedToolCallIds).toEqual([]);
    expect(out[1]).toBe(messages[1]);
  });

  // The prod failure that the live smoke surfaced: a tier-3 tool approved and
  // executing, then superseded by a new user message. Its part is
  // `approval-responded` (approved) with no output — repair must give it a
  // synthetic result or convertToModelMessages emits a dangling tool_use and
  // the provider 400s the whole request ("tool_use ids without tool_result").
  it('repairs an APPROVED approval-responded part superseded mid-execution', () => {
    const approvedInflight = {
      type: 'tool-execute_script',
      toolCallId: 'toolu_appr_exec_1',
      state: 'approval-responded',
      input: { script: 'Start-Sleep -Seconds 300' },
      approval: { id: 'appr_3', approved: true },
    };
    const messages = [
      userMsg('u1', 'run the long script'),
      assistantMsg('a1', [{ type: 'text', text: 'running that now' }, approvedInflight]),
      userMsg('u2', 'while that runs, what is the uptime?'),
    ];

    const { messages: out, repairedToolCallIds } = repairDanglingToolParts(messages);

    expect(repairedToolCallIds).toEqual(['toolu_appr_exec_1']);
    const part = (out[1].parts as Array<Record<string, unknown>>)[1];
    expect(part).toMatchObject({
      type: 'tool-execute_script',
      toolCallId: 'toolu_appr_exec_1',
      state: 'output-error',
      errorText: LOST_RESULT_ERROR,
    });
    expect(part.approval).toBeUndefined();
  });

  it('recovers the real result for an APPROVED approval-responded part via the resolver', async () => {
    const approvedInflight = {
      type: 'tool-execute_script',
      toolCallId: 'toolu_appr_exec_2',
      state: 'approval-responded',
      input: { script: 'Get-Uptime' },
      approval: { id: 'appr_4', approved: true },
    };
    const messages = [
      userMsg('u1', 'run it'),
      assistantMsg('a1', [approvedInflight]),
      userMsg('u2', 'and?'),
    ];

    const seen: string[] = [];
    const { messages: out } = await repairDanglingToolParts(messages, {
      resolveLostResult: async (id) => {
        seen.push(id);
        return { output: { exit_code: 0, stdout: 'up 3 days' } };
      },
    });

    expect(seen).toContain('toolu_appr_exec_2');
    expect((out[1].parts as Array<Record<string, unknown>>)[0]).toMatchObject({
      state: 'output-available',
      output: { exit_code: 0, stdout: 'up 3 days' },
    });
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

describe('repairDanglingToolParts with resolveLostResult (async overload)', () => {
  function brokenHistory(): UIMessage[] {
    return [
      userMsg('u1', 'run sfc and dism'),
      assistantMsg('a1', [{ type: 'text', text: 'running both' }, completedToolPart, danglingToolPart]),
      userMsg('u2', 'still running?'),
    ];
  }

  it('splices a recovered { output } in as output-available', async () => {
    const recovered = { exit_code: 0, stdout: 'scan complete, no violations' };
    const resolveLostResult = jest.fn().mockResolvedValue({ output: recovered });

    const { messages: out, repairedToolCallIds } = await repairDanglingToolParts(brokenHistory(), {
      resolveLostResult,
    });

    expect(resolveLostResult).toHaveBeenCalledTimes(1);
    expect(resolveLostResult).toHaveBeenCalledWith('toolu_dangling_1');
    expect(repairedToolCallIds).toEqual(['toolu_dangling_1']);
    const parts = out[1].parts as Array<Record<string, unknown>>;
    expect(parts[1]).toBe(completedToolPart); // untouched sibling
    expect(parts[2]).toMatchObject({
      type: 'tool-execute_script',
      toolCallId: 'toolu_dangling_1',
      state: 'output-available',
      output: recovered,
      input: danglingToolPart.input, // captured input preserved
    });
    expect((parts[2] as Record<string, unknown>).errorText).toBeUndefined();

    // The recovered history must also satisfy the SDK's validation.
    const modelMessages = await convertToModelMessages(out);
    const toolResults = modelMessages
      .filter((m) => m.role === 'tool')
      .flatMap((m) => m.content as Array<{ type: string; toolCallId?: string }>);
    expect(toolResults.some((c) => c.toolCallId === 'toolu_dangling_1')).toBe(true);
  });

  it('uses a resolver-supplied { errorText } for the output-error', async () => {
    const { messages: out } = await repairDanglingToolParts(brokenHistory(), {
      resolveLostResult: async () => ({ errorText: STILL_RUNNING_ERROR }),
    });

    expect((out[1].parts as Array<Record<string, unknown>>)[2]).toMatchObject({
      state: 'output-error',
      errorText: STILL_RUNNING_ERROR,
      input: danglingToolPart.input,
    });
  });

  it('falls back to LOST_RESULT_ERROR when the resolver returns null', async () => {
    const { messages: out, repairedToolCallIds } = await repairDanglingToolParts(brokenHistory(), {
      resolveLostResult: async () => null,
    });

    expect(repairedToolCallIds).toEqual(['toolu_dangling_1']);
    expect((out[1].parts as Array<Record<string, unknown>>)[2]).toMatchObject({
      state: 'output-error',
      errorText: LOST_RESULT_ERROR,
    });
  });

  it('never invokes the resolver for superseded approval-requested parts', async () => {
    const resolveLostResult = jest.fn().mockResolvedValue({ output: { exit_code: 0 } });
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

    const { messages: out, repairedToolCallIds } = await repairDanglingToolParts(messages, {
      resolveLostResult,
    });

    expect(resolveLostResult).not.toHaveBeenCalled();
    expect(repairedToolCallIds).toEqual(['toolu_approval_1']);
    expect((out[1].parts as Array<Record<string, unknown>>)[0]).toMatchObject({
      state: 'output-error',
      errorText: SUPERSEDED_APPROVAL_ERROR, // the tool never ran — not resolver-eligible
    });
  });

  it('keeps the no-opts signature synchronous (not a Promise)', () => {
    const result = repairDanglingToolParts(brokenHistory());

    expect(result).not.toBeInstanceOf(Promise);
    expect(result.repairedToolCallIds).toEqual(['toolu_dangling_1']);
  });
});
