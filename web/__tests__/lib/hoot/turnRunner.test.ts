/** @jest-environment node */

/**
 * Unit tests for `web/lib/hoot/turnRunner.server.ts`
 * (hoot-async-turns wave 2.2).
 *
 * Drives `startTurn` end-to-end with a MockLanguageModelV3 (real streamText /
 * createUIMessageStream / readUIMessageStream plumbing) against an in-memory
 * firestore + mocked collaborators, pinning:
 *   1. snapshots written to the turn store while the turn streams; final
 *      persist to `chats/{chatId}` with the useHoot-mirrored shape;
 *      `finishTurn('complete')`; categorization fired for new conversations
 *   2. existing conversations: no title/createdAt overwrite, no categorize
 *   3. site-wide mode persist shape + site prompt + online-machine fan-out
 *   4. transient `data-heartbeat` chunks on the HTTP branch during the turn
 *   5. toolCommand recovery-index recording + throttled poll-tick touches via
 *      the buildExecutableTools toolCallbacks contract (Task 2.1)
 *   6. history repair recovery: prior-turn commandIds spliced in from
 *      `commands/completed` (real output / still-running / nothing found)
 *   7. error paths (model failure, setup failure) end the turn with
 *      `finishTurn('error')`, surface an error chunk, and skip the persist
 *   8. superseded turns (`finishTurn` → false) skip the final chat persist
 */

import {
  jsonSchema,
  tool,
  type InferUIMessageChunk,
  type UIMessage,
} from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import {
  LOST_RESULT_ERROR,
  STILL_RUNNING_ERROR,
} from '@/lib/hoot/repairMessages';

jest.mock('firebase-admin/firestore', () => ({
  __esModule: true,
  FieldValue: { serverTimestamp: () => '__SERVER_TS__' },
}));

jest.mock('@/lib/hoot/turnStore.server', () => ({
  __esModule: true,
  writeSnapshot: jest.fn(),
  touch: jest.fn(),
  recordToolCommand: jest.fn(),
  finishTurn: jest.fn(),
}));

jest.mock('@/lib/hoot-utils.server', () => ({
  __esModule: true,
  resolveLlmConfig: jest.fn(),
  getHootRequireTier3Approval: jest.fn(),
  getOnlineMachines: jest.fn(),
  resolveHootMaxTier: jest.fn(),
  buildExecutableTools: jest.fn(),
}));

jest.mock('@/lib/llm', () => ({
  __esModule: true,
  createModel: jest.fn(),
  createCheapModel: jest.fn(),
  buildSystemPrompt: jest.fn(),
}));

jest.mock('@/lib/mcp-tools', () => ({
  __esModule: true,
  getToolsByTier: jest.fn(),
}));

jest.mock('@/lib/hoot/categorizeChat.server', () => ({
  __esModule: true,
  categorizeNewChat: jest.fn(),
}));

import * as turnStore from '@/lib/hoot/turnStore.server';
import * as hootUtils from '@/lib/hoot-utils.server';
import * as llm from '@/lib/llm';
import { getToolsByTier } from '@/lib/mcp-tools';
import { categorizeNewChat } from '@/lib/hoot/categorizeChat.server';
import {
  startTurn,
  _setTurnTimingForTests,
  type StartTurnParams,
} from '@/lib/hoot/turnRunner.server';

/* -------------------------------------------------------------------------- */
/*  in-memory firestore                                                       */
/* -------------------------------------------------------------------------- */

type Store = Record<string, Record<string, unknown>>;
const store: Store = {};

function docRef(path: string) {
  return {
    get: async () => {
      const data = store[path];
      return { exists: data !== undefined, data: () => (data ? { ...data } : undefined) };
    },
    set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      store[path] = opts?.merge ? { ...(store[path] ?? {}), ...data } : { ...data };
    },
    update: async (patch: Record<string, unknown>) => {
      if (!store[path]) throw new Error(`update on missing doc: ${path}`);
      store[path] = { ...store[path], ...patch };
    },
    collection: (name: string) => collectionRef(`${path}/${name}`),
  };
}

function collectionRef(path: string) {
  return { doc: (id: string) => docRef(`${path}/${id}`) };
}

const fakeDb = {
  collection: (name: string) => collectionRef(name),
} as unknown as FirebaseFirestore.Firestore;

/* -------------------------------------------------------------------------- */
/*  fixtures + helpers                                                        */
/* -------------------------------------------------------------------------- */

const CHAT_ID = 'chat_1';
const TURN_ID = 'turn_1';
const SITE_ID = 'site-A';
const MACHINE_ID = 'machine-1';
const CHAT_PATH = `chats/${CHAT_ID}`;

function userMsg(id: string, text: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] } as UIMessage;
}

function assistantMsg(id: string, parts: unknown[]): UIMessage {
  return { id, role: 'assistant', parts } as UIMessage;
}

function baseParams(overrides: Partial<StartTurnParams> = {}): StartTurnParams {
  return {
    chatId: CHAT_ID,
    turnId: TURN_ID,
    siteId: SITE_ID,
    machineId: MACHINE_ID,
    machineName: 'Machine One',
    messages: [userMsg('u1', 'check the cpu')],
    userId: 'user-1',
    access: { role: 'admin', isSuperadmin: false, isSiteAdmin: true, isSiteOwner: true },
    ...overrides,
  };
}

const finishChunk = {
  type: 'finish' as const,
  finishReason: 'stop' as const,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

function textChunks(text = 'all good') {
  return [
    { type: 'text-start' as const, id: 't1' },
    { type: 'text-delta' as const, id: 't1', delta: text },
    { type: 'text-end' as const, id: 't1' },
    finishChunk,
  ];
}

function textModel(text = 'all good') {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks: textChunks(text) }),
    }),
  });
}

/** The model createModel hands to the runner (swapped per test). */
let mockModel: MockLanguageModelV3 = textModel();

type Chunk = InferUIMessageChunk<UIMessage> & { errorText?: string; transient?: boolean };

async function collectChunks(stream: ReadableStream<InferUIMessageChunk<UIMessage>>) {
  const chunks: Chunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as Chunk);
  }
  return chunks;
}

/** Let detached promise chains (snapshot pump tail, categorize) settle. */
async function flushAsync() {
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Simulates Task 2.1's buildExecutableTools: a real AI SDK tool whose execute
 * reports the queued command + poll ticks through the toolCallbacks contract.
 */
function stubBuildTools(
  _db: unknown,
  _siteId: string,
  machineId: string,
  _chatId: string,
  _toolDefs: unknown,
  _siteMode?: boolean,
  _onlineMachines?: string[],
  options?: {
    toolCallbacks?: {
      onCommandQueued?: (toolCallId: string, commandId: string, machineId: string) => unknown;
      onPollTick?: () => void;
    };
  },
) {
  return {
    get_metrics: tool({
      description: 'read machine metrics',
      inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
      execute: async (_input, { toolCallId }) => {
        options?.toolCallbacks?.onCommandQueued?.(toolCallId, 'cmd_test_1', machineId);
        // onPollTick is no longer wired by the runner (poll-tick touches were
        // removed); these are inert no-ops kept to prove the runner doesn't
        // pass the hook anymore.
        options?.toolCallbacks?.onPollTick?.();
        options?.toolCallbacks?.onPollTick?.();
        return { cpu: 12 };
      },
    }),
  };
}

/* -------------------------------------------------------------------------- */
/*  setup                                                                     */
/* -------------------------------------------------------------------------- */

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  mockModel = textModel();
  _setTurnTimingForTests(); // defaults (20s heartbeat — inert in fast tests)

  (turnStore.writeSnapshot as jest.Mock).mockResolvedValue(true);
  // touch now returns a tri-state ownership signal ('owned' | 'lost' | 'error').
  (turnStore.touch as jest.Mock).mockResolvedValue('owned');
  (turnStore.recordToolCommand as jest.Mock).mockResolvedValue(true);
  (turnStore.finishTurn as jest.Mock).mockResolvedValue(true);

  (hootUtils.resolveLlmConfig as jest.Mock).mockResolvedValue({
    provider: 'anthropic',
    apiKey: 'k',
  });
  (hootUtils.getHootRequireTier3Approval as jest.Mock).mockResolvedValue(true);
  (hootUtils.getOnlineMachines as jest.Mock).mockResolvedValue(['machine-1', 'machine-2']);
  (hootUtils.resolveHootMaxTier as jest.Mock).mockReturnValue(3);
  (hootUtils.buildExecutableTools as jest.Mock).mockImplementation(stubBuildTools);

  (llm.createModel as jest.Mock).mockImplementation(() => mockModel);
  (llm.createCheapModel as jest.Mock).mockReturnValue('CHEAP_MODEL');
  (llm.buildSystemPrompt as jest.Mock).mockImplementation(
    (machineName: string, siteMode?: boolean) =>
      siteMode ? 'SITE PROMPT' : `MACHINE PROMPT ${machineName}`,
  );

  (getToolsByTier as jest.Mock).mockReturnValue([
    {
      name: 'get_metrics',
      description: 'read machine metrics',
      parameters: { type: 'object', properties: {} },
      tier: 1,
    },
  ]);

  (categorizeNewChat as jest.Mock).mockResolvedValue({ title: 't', category: 'General' });
});

afterEach(() => {
  _setTurnTimingForTests();
});

/* -------------------------------------------------------------------------- */
/*  happy path                                                                */
/* -------------------------------------------------------------------------- */

describe('startTurn — happy path', () => {
  it('streams text, writes snapshots, persists the final chat, and finishes the turn', async () => {
    const chunks = await collectChunks(startTurn(fakeDb, baseParams()));
    await flushAsync();

    // Live HTTP branch got the text.
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true);
    expect(chunks.some((c) => c.type === 'error')).toBe(false);

    // Snapshots flowed into the turn store while streaming.
    expect(turnStore.writeSnapshot).toHaveBeenCalledWith(
      fakeDb,
      CHAT_ID,
      TURN_ID,
      expect.objectContaining({ role: 'assistant' }),
    );

    // Turn marked complete exactly once.
    expect(turnStore.finishTurn).toHaveBeenCalledTimes(1);
    expect(turnStore.finishTurn).toHaveBeenCalledWith(fakeDb, CHAT_ID, TURN_ID, 'complete');

    // Final chat persist mirrors the useHoot client shape (new conversation).
    const chat = store[CHAT_PATH];
    expect(chat).toMatchObject({
      userId: 'user-1',
      siteId: SITE_ID,
      targetType: 'machine',
      targetMachineId: MACHINE_ID,
      machineName: 'Machine One',
      title: 'check the cpu',
      updatedAt: '__SERVER_TS__',
      createdAt: '__SERVER_TS__',
    });
    const messages = chat.messages as Array<{ id: string; role: string; parts: unknown[] }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ id: 'u1', role: 'user' });
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'all good' })]),
    );

    // New conversation → categorization fired with the first user text.
    expect(categorizeNewChat).toHaveBeenCalledWith(
      fakeDb,
      'CHEAP_MODEL',
      CHAT_ID,
      'check the cpu',
    );

    // Single-machine prompt + process summaries path.
    expect(llm.buildSystemPrompt).toHaveBeenCalledWith('Machine One', false, []);
  });

  it('truncates long first-user-text titles to 100 chars', async () => {
    const longText = 'x'.repeat(150);
    await collectChunks(startTurn(fakeDb, baseParams({ messages: [userMsg('u1', longText)] })));
    await flushAsync();

    expect((store[CHAT_PATH].title as string).length).toBe(100);
  });

  it('does not overwrite title/createdAt or categorize on existing conversations', async () => {
    store[CHAT_PATH] = { title: 'llm generated title', createdAt: 'orig' };
    const params = baseParams({
      messages: [
        userMsg('u1', 'check the cpu'),
        assistantMsg('a1', [{ type: 'text', text: 'looks fine' }]),
        userMsg('u2', 'and the memory?'),
      ],
    });

    await collectChunks(startTurn(fakeDb, params));
    await flushAsync();

    expect(store[CHAT_PATH].title).toBe('llm generated title');
    expect(store[CHAT_PATH].createdAt).toBe('orig');
    expect(
      (store[CHAT_PATH].messages as unknown[]).length,
    ).toBe(4);
    expect(categorizeNewChat).not.toHaveBeenCalled();
  });

  it('site-wide mode: site prompt, online-machine fan-out, and site persist shape', async () => {
    await collectChunks(startTurn(fakeDb, baseParams({ machineId: '__site__', machineName: '' })));
    await flushAsync();

    expect(llm.buildSystemPrompt).toHaveBeenCalledWith('', true);
    expect(hootUtils.buildExecutableTools).toHaveBeenCalledWith(
      fakeDb,
      SITE_ID,
      '__site__',
      CHAT_ID,
      expect.any(Array),
      true,
      ['machine-1', 'machine-2'],
      expect.objectContaining({ userId: 'user-1', requireTier3Approval: true }),
    );
    expect(store[CHAT_PATH]).toMatchObject({
      targetType: 'site',
      targetMachineId: null,
      machineName: 'All Machines',
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  heartbeat                                                                 */
/* -------------------------------------------------------------------------- */

describe('startTurn — heartbeat', () => {
  it('emits transient data-heartbeat chunks on the HTTP branch during a slow turn', async () => {
    _setTurnTimingForTests({ heartbeatMs: 15 });
    mockModel = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({ chunkDelayInMs: 30, chunks: textChunks() }),
      }),
    });

    const chunks = await collectChunks(startTurn(fakeDb, baseParams()));
    await flushAsync();

    const heartbeats = chunks.filter((c) => c.type === 'data-heartbeat');
    expect(heartbeats.length).toBeGreaterThan(0);
    expect(heartbeats[0]).toMatchObject({ transient: true, data: expect.any(Number) });

    // Heartbeat ticks also keep the stream doc fresh.
    expect(turnStore.touch).toHaveBeenCalledWith(fakeDb, CHAT_ID, TURN_ID);

    // Transient parts never leak into the persisted message.
    const messages = store[CHAT_PATH].messages as Array<{ parts: Array<{ type: string }> }>;
    expect(messages[1].parts.some((p) => p.type === 'data-heartbeat')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  tool callbacks                                                            */
/* -------------------------------------------------------------------------- */

describe('startTurn — tool command recording', () => {
  it('records queued commands and throttles poll-tick touches', async () => {
    let call = 0;
    mockModel = new MockLanguageModelV3({
      doStream: async () => {
        call += 1;
        return {
          stream: simulateReadableStream({
            chunks:
              call === 1
                ? [
                    {
                      type: 'tool-call' as const,
                      toolCallId: 'call_1',
                      toolName: 'get_metrics',
                      input: '{}',
                    },
                    { ...finishChunk, finishReason: 'tool-calls' as const },
                  ]
                : textChunks('cpu is at 12%'),
          }),
        };
      },
    });

    const chunks = await collectChunks(startTurn(fakeDb, baseParams()));
    await flushAsync();

    // toolCallId → {commandId, machineId} recovery index recorded via callback.
    expect(turnStore.recordToolCommand).toHaveBeenCalledTimes(1);
    expect(turnStore.recordToolCommand).toHaveBeenCalledWith(
      fakeDb,
      CHAT_ID,
      TURN_ID,
      'call_1',
      'cmd_test_1',
      MACHINE_ID,
    );

    // Per-poll touches were removed (the ~20s heartbeat covers staleness) — the
    // only touch is the turn-start persist's ownership gate.
    expect(turnStore.touch).toHaveBeenCalledTimes(1);
    expect(turnStore.touch).toHaveBeenCalledWith(fakeDb, CHAT_ID, TURN_ID);

    // The tool round-trip made it onto the stream and into the persisted chat.
    expect(chunks.some((c) => c.type === 'tool-output-available')).toBe(true);
    const messages = store[CHAT_PATH].messages as Array<{ parts: Array<Record<string, unknown>> }>;
    expect(messages[1].parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool-get_metrics',
          state: 'output-available',
          output: { cpu: 12 },
        }),
      ]),
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  repair recovery                                                           */
/* -------------------------------------------------------------------------- */

describe('startTurn — dangling-tool recovery via priorToolCommands', () => {
  const danglingHistory = () => [
    userMsg('u1', 'check the metrics'),
    assistantMsg('a1', [
      {
        type: 'tool-get_metrics',
        toolCallId: 'toolu_lost_1',
        state: 'input-available',
        input: {},
      },
    ]),
    userMsg('u2', 'did it finish?'),
  ];
  const priorToolCommands = {
    toolu_lost_1: { [MACHINE_ID]: { commandId: 'cmd_lost_1' } },
  };
  const COMPLETED_PATH = `sites/${SITE_ID}/machines/${MACHINE_ID}/commands/completed`;

  let capturedPrompt: unknown;

  beforeEach(() => {
    capturedPrompt = undefined;
    mockModel = new MockLanguageModelV3({
      doStream: async (options) => {
        capturedPrompt = options.prompt;
        return { stream: simulateReadableStream({ chunks: textChunks() }) };
      },
    });
  });

  it('splices the real result in when the completed entry is terminal', async () => {
    store[COMPLETED_PATH] = {
      cmd_lost_1: { status: 'completed', result: '{"exit_code":0,"stdout":"done"}' },
    };

    await collectChunks(
      startTurn(fakeDb, baseParams({ messages: danglingHistory(), priorToolCommands })),
    );
    await flushAsync();

    const prompt = JSON.stringify(capturedPrompt);
    expect(prompt).toContain('"exit_code":0');
    expect(prompt).not.toContain(LOST_RESULT_ERROR.slice(0, 20));
  });

  it('reports still-running when the completed entry has status running', async () => {
    store[COMPLETED_PATH] = { cmd_lost_1: { status: 'running' } };

    await collectChunks(
      startTurn(fakeDb, baseParams({ messages: danglingHistory(), priorToolCommands })),
    );
    await flushAsync();

    expect(JSON.stringify(capturedPrompt)).toContain(STILL_RUNNING_ERROR);
  });

  it('surfaces the recorded error for a failed entry', async () => {
    store[COMPLETED_PATH] = { cmd_lost_1: { status: 'failed', error: 'agent exploded' } };

    await collectChunks(
      startTurn(fakeDb, baseParams({ messages: danglingHistory(), priorToolCommands })),
    );
    await flushAsync();

    expect(JSON.stringify(capturedPrompt)).toContain('agent exploded');
  });

  it('falls back to the synthesized lost-result error when nothing is recorded', async () => {
    await collectChunks(startTurn(fakeDb, baseParams({ messages: danglingHistory() })));
    await flushAsync();

    expect(JSON.stringify(capturedPrompt)).toContain(
      JSON.stringify(LOST_RESULT_ERROR).slice(1, -1),
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  site-wide recovery aggregation                                            */
/* -------------------------------------------------------------------------- */

describe('startTurn — site-wide dangling-tool recovery aggregation', () => {
  const danglingHistory = () => [
    userMsg('u1', 'grab system info everywhere'),
    assistantMsg('a1', [
      {
        type: 'tool-get_system_info',
        toolCallId: 'toolu_site_1',
        state: 'input-available',
        input: {},
      },
    ]),
    userMsg('u2', 'how did it go?'),
  ];

  // One toolCallId fanned out to three machines (the nested recovery index).
  const priorToolCommands = {
    toolu_site_1: {
      'machine-1': { commandId: 'cmd_m1' },
      'machine-2': { commandId: 'cmd_m2' },
      'machine-3': { commandId: 'cmd_m3' },
    },
  };
  const completedPath = (m: string) => `sites/${SITE_ID}/machines/${m}/commands/completed`;

  let capturedPrompt: unknown;

  beforeEach(() => {
    capturedPrompt = undefined;
    (hootUtils.getOnlineMachines as jest.Mock).mockResolvedValue([
      'machine-1',
      'machine-2',
      'machine-3',
    ]);
    mockModel = new MockLanguageModelV3({
      doStream: async (options) => {
        capturedPrompt = options.prompt;
        return { stream: simulateReadableStream({ chunks: textChunks() }) };
      },
    });
  });

  it('aggregates per-machine results into { machines: [...] } (success + running + failed)', async () => {
    store[completedPath('machine-1')] = {
      cmd_m1: { status: 'completed', result: '{"hostname":"HOST-1"}' },
    };
    store[completedPath('machine-2')] = { cmd_m2: { status: 'running' } };
    store[completedPath('machine-3')] = {
      cmd_m3: { status: 'failed', error: 'boom on 3' },
    };

    await collectChunks(
      startTurn(
        fakeDb,
        baseParams({
          machineId: '__site__',
          machineName: '',
          messages: danglingHistory(),
          priorToolCommands,
        }),
      ),
    );
    await flushAsync();

    const prompt = JSON.stringify(capturedPrompt);
    // Live site path shape: { machines: [{ machine, ...result }, ...] }.
    expect(prompt).toContain('"machine":"machine-1"');
    expect(prompt).toContain('HOST-1');
    // A still-running machine surfaces the honest STILL_RUNNING note.
    expect(prompt).toContain('"machine":"machine-2"');
    expect(prompt).toContain(STILL_RUNNING_ERROR);
    // A failed machine surfaces its recorded error.
    expect(prompt).toContain('"machine":"machine-3"');
    expect(prompt).toContain('boom on 3');
    // Not the synthesized single-machine lost-result fallback.
    expect(prompt).not.toContain(LOST_RESULT_ERROR.slice(0, 20));
  });

  it('falls back to the synthesized lost-result error when no machine entry resolves', async () => {
    // All three completed docs absent (consumed/GC'd) → aggregation yields
    // nothing → repair uses the synthesized lost-result error.
    await collectChunks(
      startTurn(
        fakeDb,
        baseParams({
          machineId: '__site__',
          machineName: '',
          messages: danglingHistory(),
          priorToolCommands,
        }),
      ),
    );
    await flushAsync();

    expect(JSON.stringify(capturedPrompt)).toContain(
      JSON.stringify(LOST_RESULT_ERROR).slice(1, -1),
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  heartbeat ownership → abort                                               */
/* -------------------------------------------------------------------------- */

describe('startTurn — heartbeat abort decision', () => {
  /**
   * A model that dispatches a blocking tool, then (on the follow-up step)
   * emits text. The tool blocks on its abortSignal (up to a short fallback)
   * and records whether it observed an abort — the observable for whether the
   * heartbeat fired `abortController.abort()`.
   */
  function blockingToolSetup(observe: { aborted: boolean }) {
    (hootUtils.buildExecutableTools as jest.Mock).mockImplementation(() => ({
      get_metrics: tool({
        description: 'blocking metric read',
        inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
        execute: async (_input, { abortSignal }: { abortSignal?: AbortSignal }) => {
          await new Promise<void>((resolve) => {
            if (abortSignal?.aborted) return resolve();
            const to = setTimeout(resolve, 300);
            abortSignal?.addEventListener('abort', () => {
              clearTimeout(to);
              resolve();
            });
          });
          observe.aborted = abortSignal?.aborted ?? false;
          return { cpu: 1 };
        },
      }),
    }));

    let call = 0;
    mockModel = new MockLanguageModelV3({
      doStream: async () => {
        call += 1;
        return {
          stream: simulateReadableStream({
            chunks:
              call === 1
                ? [
                    {
                      type: 'tool-call' as const,
                      toolCallId: 'call_block',
                      toolName: 'get_metrics',
                      input: '{}',
                    },
                    { ...finishChunk, finishReason: 'tool-calls' as const },
                  ]
                : textChunks('done'),
          }),
        };
      },
    });
  }

  it("aborts the in-flight turn when the heartbeat reports genuine loss ('lost')", async () => {
    _setTurnTimingForTests({ heartbeatMs: 10 });
    (turnStore.touch as jest.Mock).mockResolvedValue('lost');
    const observe = { aborted: false };
    blockingToolSetup(observe);

    await collectChunks(startTurn(fakeDb, baseParams()));
    await flushAsync();

    expect(observe.aborted).toBe(true);
  });

  it("does NOT abort on a transient heartbeat failure ('error')", async () => {
    _setTurnTimingForTests({ heartbeatMs: 10 });
    (turnStore.touch as jest.Mock).mockResolvedValue('error');
    const observe = { aborted: false };
    blockingToolSetup(observe);

    await collectChunks(startTurn(fakeDb, baseParams()));
    await flushAsync();

    // A single (or repeated) transient Firestore blip must not kill a healthy,
    // still-owned turn — the tool ran to completion without an abort.
    expect(observe.aborted).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  error paths                                                               */
/* -------------------------------------------------------------------------- */

describe('startTurn — error paths', () => {
  it('model failure: error chunk on the stream, finishTurn(error), no persist', async () => {
    mockModel = new MockLanguageModelV3({
      doStream: async () => {
        throw new Error('model exploded');
      },
    });

    const chunks = await collectChunks(startTurn(fakeDb, baseParams()));
    await flushAsync();

    expect(chunks.some((c) => c.type === 'error' && c.errorText === 'model exploded')).toBe(true);
    expect(turnStore.finishTurn).toHaveBeenCalledWith(
      fakeDb,
      CHAT_ID,
      TURN_ID,
      'error',
      'model exploded',
    );
    // Errored turns now persist the base history (durability) so a provider
    // failure can't erase a brand-new chat — but only the user message (no
    // assistant response) lands, and categorization never fires.
    expect(store[CHAT_PATH]).toBeDefined();
    const messages = store[CHAT_PATH].messages as Array<{ id: string; role: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: 'u1', role: 'user' });
    expect(categorizeNewChat).not.toHaveBeenCalled();
  });

  it('setup failure (llm config): stream still terminates with an error chunk', async () => {
    (hootUtils.resolveLlmConfig as jest.Mock).mockRejectedValue(
      new Error('No LLM API key configured.'),
    );

    const chunks = await collectChunks(startTurn(fakeDb, baseParams()));
    await flushAsync();

    expect(
      chunks.some((c) => c.type === 'error' && c.errorText === 'No LLM API key configured.'),
    ).toBe(true);
    expect(turnStore.finishTurn).toHaveBeenCalledWith(
      fakeDb,
      CHAT_ID,
      TURN_ID,
      'error',
      'No LLM API key configured.',
    );
    // The user message is still durably persisted (turn-start persist ran
    // before the setup failure).
    expect(store[CHAT_PATH]).toBeDefined();
    expect((store[CHAT_PATH].messages as unknown[]).length).toBe(1);
  });

  it('site-wide mode with no online machines errors instead of hanging', async () => {
    (hootUtils.getOnlineMachines as jest.Mock).mockResolvedValue([]);

    const chunks = await collectChunks(startTurn(fakeDb, baseParams({ machineId: '__site__' })));
    await flushAsync();

    expect(chunks.some((c) => c.type === 'error')).toBe(true);
    expect(turnStore.finishTurn).toHaveBeenCalledWith(
      fakeDb,
      CHAT_ID,
      TURN_ID,
      'error',
      'No machines are currently online in this site.',
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  supersede                                                                 */
/* -------------------------------------------------------------------------- */

describe('startTurn — superseded turn', () => {
  it('skips both the turn-start and final chat persist when the turn lost the doc', async () => {
    // A superseded turn loses ownership: the guarded `touch` reports `lost`
    // (turn-start persist gate skips; heartbeat would abort) and `finishTurn`
    // reports `false`, so neither the start nor the final persist writes.
    (turnStore.touch as jest.Mock).mockResolvedValue('lost');
    (turnStore.finishTurn as jest.Mock).mockResolvedValue(false);

    const chunks = await collectChunks(startTurn(fakeDb, baseParams()));
    await flushAsync();

    // The stream itself still completed for whoever was watching it…
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true);
    expect(turnStore.finishTurn).toHaveBeenCalledWith(fakeDb, CHAT_ID, TURN_ID, 'complete');
    // …but the superseding turn owns the chat doc now.
    expect(store[CHAT_PATH]).toBeUndefined();
    expect(categorizeNewChat).not.toHaveBeenCalled();
  });
});
