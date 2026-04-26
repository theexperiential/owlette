/**
 * HTTP-shape tests for `owlette chat new | list | send | delete | rename`.
 *
 * Intercepts global.fetch, builds an in-process commander program, and
 * asserts the request URL/method/headers/body match the contract documented
 * in `src/commands/chat.ts`. Streaming bodies are supplied via an async
 * iterator so we can drive `chat send` through its full deltas → flush
 * → final-newline path without a real network.
 */

import { Command } from 'commander';
import { registerChatCommands } from '../../src/commands/chat';
import { _resetConfigCache } from '../../src/config';

function buildProgram(): Command {
  const program = new Command();
  program.name('owlette').exitOverride().option('--profile <name>').option('--json');
  registerChatCommands(program);
  return program;
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function installFetchStub(payload: unknown, status = 200): FetchCall[] {
  const calls: FetchCall[] = [];
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(
    async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      } as Response;
    },
  );
  return calls;
}

/**
 * Stub fetch with a streaming body — emits the AI-SDK v3 line-delimited
 * frames the CLI parses (one or more `0:"..."` deltas, optionally
 * terminated by a `d:` end frame).
 */
function installStreamingFetchStub(frames: string[]): FetchCall[] {
  const calls: FetchCall[] = [];
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(
    async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const encoder = new TextEncoder();
      const body = {
        async *[Symbol.asyncIterator]() {
          for (const frame of frames) yield encoder.encode(frame);
        },
      } as unknown as ReadableStream<Uint8Array>;
      return {
        ok: true,
        status: 200,
        body,
        json: async () => ({}),
        text: async () => '',
      } as unknown as Response;
    },
  );
  return calls;
}

let originalFetch: typeof global.fetch;
beforeAll(() => {
  originalFetch = global.fetch;
});
afterAll(() => {
  global.fetch = originalFetch;
});

beforeEach(() => {
  _resetConfigCache();
  process.env.OWLETTE_TOKEN = 'owk_live_testtoken';
  process.env.OWLETTE_API_URL = 'https://dev.test';
  process.env.OWLETTE_PROFILE = 'default';
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  delete process.env.OWLETTE_TOKEN;
  delete process.env.OWLETTE_API_URL;
  delete process.env.OWLETTE_PROFILE;
  jest.restoreAllMocks();
});

/* -------------------- new -------------------- */

describe('owlette chat new', () => {
  it('POSTs /api/chat/new with siteId + Bearer + auto Idempotency-Key', async () => {
    const calls = installFetchStub({ ok: true, data: { conversationId: 'conv_1' } });
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'chat', 'new', '--site', 'site-1'],
      { from: 'user' },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://dev.test/api/chat/new');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Idempotency-Key']).toMatch(/^cli-chat-new-/);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({ siteId: 'site-1' });
  });

  it('forwards --machine and --title in the body', async () => {
    const calls = installFetchStub({ ok: true, data: { conversationId: 'conv_2' } });
    const program = buildProgram();
    await program.parseAsync(
      [
        '--json',
        'chat',
        'new',
        '--site',
        'site-1',
        '--machine',
        'm-1',
        '--title',
        'tuesday rollout',
      ],
      { from: 'user' },
    );
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({
      siteId: 'site-1',
      machineId: 'm-1',
      title: 'tuesday rollout',
    });
  });

  it('round-trips the unwrapped data envelope in --json mode', async () => {
    const data = {
      conversationId: 'conv_3',
      siteId: 'site-1',
      title: null,
      ownerUid: 'u_1',
      messageCount: 0,
    };
    installFetchStub({ ok: true, data });
    const writes: string[] = [];
    (process.stdout.write as unknown as jest.Mock).mockImplementation(
      (chunk: string) => {
        writes.push(chunk);
        return true;
      },
    );
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'chat', 'new', '--site', 'site-1'],
      { from: 'user' },
    );
    const out = JSON.parse(writes.join(''));
    expect(out).toEqual(data);
  });

  it('uses the provided --idempotency-key verbatim when present', async () => {
    const calls = installFetchStub({ ok: true, data: { conversationId: 'conv_4' } });
    const program = buildProgram();
    await program.parseAsync(
      [
        '--json',
        'chat',
        'new',
        '--site',
        'site-1',
        '--idempotency-key',
        'caller-supplied-key',
      ],
      { from: 'user' },
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('caller-supplied-key');
  });
});

/* -------------------- list -------------------- */

describe('owlette chat list', () => {
  it('GETs /api/chat with siteId + Bearer auth', async () => {
    const calls = installFetchStub({
      ok: true,
      data: { conversations: [], nextPageToken: '' },
    });
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'chat', 'list', '--site', 'site-1'],
      { from: 'user' },
    );
    expect(calls[0]!.url).toBe('https://dev.test/api/chat?siteId=site-1');
    expect((calls[0]!.init.method ?? 'GET').toUpperCase()).toBe('GET');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
  });

  it('forwards --limit (page_size) and --cursor (page_token) query params', async () => {
    const calls = installFetchStub({
      ok: true,
      data: { conversations: [], nextPageToken: '' },
    });
    const program = buildProgram();
    await program.parseAsync(
      [
        '--json',
        'chat',
        'list',
        '--site',
        'site-1',
        '--limit',
        '5',
        '--cursor',
        'tok-2',
      ],
      { from: 'user' },
    );
    expect(calls[0]!.url).toContain('page_size=5');
    expect(calls[0]!.url).toContain('page_token=tok-2');
    expect(calls[0]!.url).toContain('siteId=site-1');
  });

  it('emits the {conversations, nextPageToken} envelope in --json mode', async () => {
    const conversations = [
      {
        conversationId: 'conv_a',
        title: 'alpha',
        siteId: 'site-1',
        ownerUid: 'u_1',
        createdAt: '2026-04-01T00:00:00Z',
        updatedAt: '2026-04-02T00:00:00Z',
        messageCount: 4,
      },
    ];
    installFetchStub({ ok: true, data: { conversations, nextPageToken: 'next-1' } });
    const writes: string[] = [];
    (process.stdout.write as unknown as jest.Mock).mockImplementation(
      (chunk: string) => {
        writes.push(chunk);
        return true;
      },
    );
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'chat', 'list', '--site', 'site-1'],
      { from: 'user' },
    );
    const out = JSON.parse(writes.join(''));
    expect(out.conversations).toEqual(conversations);
    expect(out.nextPageToken).toBe('next-1');
  });
});

/* -------------------- send -------------------- */

describe('owlette chat send', () => {
  it('POSTs /api/chat/:id with role=user + content + auto Idempotency-Key', async () => {
    const calls = installStreamingFetchStub([`0:"hello"\n`, `d:{"finishReason":"stop"}\n`]);
    const program = buildProgram();
    await program.parseAsync(
      ['chat', 'send', 'conv_1', 'hi there'],
      { from: 'user' },
    );
    expect(calls[0]!.url).toBe('https://dev.test/api/chat/conv_1');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
    expect(headers['Idempotency-Key']).toMatch(/^cli-chat-send-/);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({ role: 'user', content: 'hi there' });
  });

  it('flushes 0: text deltas to stdout as they arrive', async () => {
    installStreamingFetchStub([
      `0:"hello "\n`,
      `0:"world"\n`,
      `d:{"finishReason":"stop"}\n`,
    ]);
    const writes: string[] = [];
    (process.stdout.write as unknown as jest.Mock).mockImplementation(
      (chunk: string) => {
        writes.push(chunk);
        return true;
      },
    );
    const program = buildProgram();
    await program.parseAsync(
      ['chat', 'send', 'conv_1', 'hi'],
      { from: 'user' },
    );
    const out = writes.join('');
    expect(out).toContain('hello ');
    expect(out).toContain('world');
    // Final newline is written after the stream ends.
    expect(out.endsWith('\n')).toBe(true);
  });

  it('aggregates the full reply into the json envelope in --json mode', async () => {
    installStreamingFetchStub([
      `0:"step 1 "\n`,
      `0:"step 2"\n`,
      `d:{"finishReason":"stop"}\n`,
    ]);
    const writes: string[] = [];
    (process.stdout.write as unknown as jest.Mock).mockImplementation(
      (chunk: string) => {
        writes.push(chunk);
        return true;
      },
    );
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'chat', 'send', 'conv_1', 'hi'],
      { from: 'user' },
    );
    const out = JSON.parse(writes.join(''));
    expect(out).toEqual({ conversationId: 'conv_1', content: 'step 1 step 2' });
  });
});

/* -------------------- delete -------------------- */

describe('owlette chat delete', () => {
  it('DELETEs /api/chat/:id with Bearer + auto Idempotency-Key when --yes is supplied', async () => {
    const calls = installFetchStub({
      ok: true,
      data: { conversationId: 'conv_1', alreadyDeleted: false },
    });
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'chat', 'delete', 'conv_1', '--yes'],
      { from: 'user' },
    );
    expect(calls[0]!.url).toBe('https://dev.test/api/chat/conv_1');
    expect(calls[0]!.init.method).toBe('DELETE');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
    expect(headers['Idempotency-Key']).toMatch(/^cli-chat-delete-/);
  });

  it('surfaces server error code + detail on failure', async () => {
    installFetchStub({ detail: 'gone', code: 'forbidden' }, 403);
    const stderr: string[] = [];
    (process.stderr.write as unknown as jest.Mock).mockImplementation(
      (chunk: string) => {
        stderr.push(chunk);
        return true;
      },
    );
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'chat', 'delete', 'conv_1', '--yes'],
      { from: 'user' },
    );
    const err = stderr.join('');
    expect(err).toContain('403');
    expect(err).toContain('forbidden');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

/* -------------------- rename -------------------- */

describe('owlette chat rename', () => {
  it('PATCHes /api/chat/:id with title body + auto Idempotency-Key', async () => {
    const calls = installFetchStub({
      ok: true,
      data: { conversationId: 'conv_1', title: 'new title' },
    });
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'chat', 'rename', 'conv_1', 'new title'],
      { from: 'user' },
    );
    expect(calls[0]!.url).toBe('https://dev.test/api/chat/conv_1');
    expect(calls[0]!.init.method).toBe('PATCH');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
    expect(headers['Idempotency-Key']).toMatch(/^cli-chat-rename-/);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({ title: 'new title' });
  });
});
