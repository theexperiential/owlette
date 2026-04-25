import { Command } from 'commander';
import { createHmac } from 'crypto';
import { registerTriggerCommand } from '../../src/commands/trigger';
import { _resetConfigCache } from '../../src/config';

function buildProgram(): Command {
  const program = new Command();
  program.name('roost').exitOverride().option('--profile <name>').option('--json');
  registerTriggerCommand(program);
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

let originalFetch: typeof global.fetch;
beforeAll(() => {
  originalFetch = global.fetch;
});
afterAll(() => {
  global.fetch = originalFetch;
});

beforeEach(() => {
  _resetConfigCache();
  process.env.ROOST_TOKEN = 'owk_live_testtoken';
  process.env.ROOST_API_URL = 'https://dev.test';
  process.env.ROOST_PROFILE = 'default';
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  delete process.env.ROOST_TOKEN;
  delete process.env.ROOST_API_URL;
  delete process.env.ROOST_PROFILE;
  jest.restoreAllMocks();
});

describe('roost trigger (server-probe mode)', () => {
  it('POSTs /api/webhooks/probe with {kind, siteId, deliveryId, payload}', async () => {
    const calls = installFetchStub({ success: true });
    const program = buildProgram();
    await program.parseAsync(
      [
        '--json',
        'trigger',
        'version.published',
        '--site',
        'site-1',
        '--id',
        'delivery-abc',
      ],
      { from: 'user' },
    );
    expect(calls[0]!.url).toBe('https://dev.test/api/webhooks/probe');
    expect(calls[0]!.init.method).toBe('POST');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.kind).toBe('version.published');
    expect(body.siteId).toBe('site-1');
    expect(body.deliveryId).toBe('delivery-abc');
    expect(body.payload.roostId).toBeDefined();
    expect(body.payload.siteId).toBe('site-1'); // placeholder filled at runtime
  });
});

describe('roost trigger (direct mode)', () => {
  it('POSTs to --to url with headers + hmac signature', async () => {
    const calls = installFetchStub({});
    const program = buildProgram();
    await program.parseAsync(
      [
        '--json',
        'trigger',
        'version.published',
        '--site',
        'site-1',
        '--to',
        'http://localhost:9999/hooks',
        '--signing-secret',
        'my-secret',
        '--id',
        'delivery-xyz',
      ],
      { from: 'user' },
    );
    expect(calls[0]!.url).toBe('http://localhost:9999/hooks');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Roost-Event']).toBe('version.published');
    expect(headers['Roost-Delivery']).toBe('delivery-xyz');
    expect(headers['Roost-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

    // Verify signature is valid over the actual body bytes.
    const [tPart, v1Part] = headers['Roost-Signature']!.split(',');
    const t = Number(tPart!.slice(2));
    const v1 = v1Part!.slice(3);
    const body = String(calls[0]!.init.body);
    const expected = createHmac('sha256', 'my-secret')
      .update(`${t}.${body}`)
      .digest('hex');
    expect(v1).toBe(expected);
  });

  it('omits Roost-Signature when --signing-secret is absent', async () => {
    const calls = installFetchStub({});
    const program = buildProgram();
    await program.parseAsync(
      [
        '--json',
        'trigger',
        'version.published',
        '--site',
        'site-1',
        '--to',
        'http://localhost:9999/hooks',
      ],
      { from: 'user' },
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Roost-Signature']).toBeUndefined();
  });

  it('inline --payload overrides the canned body', async () => {
    const calls = installFetchStub({});
    const program = buildProgram();
    await program.parseAsync(
      [
        '--json',
        'trigger',
        'version.published',
        '--site',
        'site-1',
        '--to',
        'http://localhost:9999/hooks',
        '--payload',
        JSON.stringify({ custom: 'shape' }),
      ],
      { from: 'user' },
    );
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({ custom: 'shape' });
  });
});
