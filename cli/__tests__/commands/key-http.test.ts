import { Command } from 'commander';
import { registerKeyCommands } from '../../src/commands/key';
import { _resetConfigCache } from '../../src/config';

function buildProgram(): Command {
  const program = new Command();
  program.name('owlette').exitOverride().option('--profile <name>').option('--json');
  registerKeyCommands(program);
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
  process.env.OWLETTE_TOKEN = 'owk_live_testtoken';
  process.env.OWLETTE_API_URL = 'https://dev.test';
  process.env.OWLETTE_PROFILE = 'default';
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  delete process.env.OWLETTE_TOKEN;
  delete process.env.OWLETTE_API_URL;
  delete process.env.OWLETTE_PROFILE;
  jest.restoreAllMocks();
});

describe('owlette key list', () => {
  it('GETs /api/keys with Bearer auth', async () => {
    const calls = installFetchStub({ success: true, keys: [] });
    const program = buildProgram();
    await program.parseAsync(['--json', 'key', 'list'], { from: 'user' });
    expect(calls[0]!.url).toBe('https://dev.test/api/keys');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
  });
});

describe('owlette key create', () => {
  it('POSTs /api/keys with name/scopes/ttl/environment from --preset', async () => {
    const calls = installFetchStub({
      success: true,
      key: 'owk_live_NEW',
      keyId: 'k1',
      name: 'ci',
      environment: 'live',
      scopes: [],
      expiresAt: Date.now() + 60_000,
      keyPrefix: 'owk_live_NEWXX',
    });
    const program = buildProgram();
    await program.parseAsync(
      [
        '--json',
        'key',
        'create',
        '--name',
        'ci',
        '--preset',
        'publisher',
        '--ttl-days',
        '30',
        '--environment',
        'live',
      ],
      { from: 'user' },
    );
    expect(calls[0]!.url).toBe('https://dev.test/api/keys');
    expect(calls[0]!.init.method).toBe('POST');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.name).toBe('ci');
    expect(body.ttlDays).toBe(30);
    expect(body.environment).toBe('live');
    // publisher preset expands to wildcard scopes over common CLI resource types
    expect(body.scopes).toHaveLength(4);
    expect(body.scopes.map((s: { resource: string }) => s.resource).sort()).toEqual([
      'chat',
      'machine',
      'roost',
      'site',
    ]);
    expect(body.scopes.every((s: { id: string }) => s.id === '*')).toBe(true);
    const perms = new Set<string>();
    for (const s of body.scopes as Array<{ permissions: string[] }>) {
      for (const p of s.permissions) perms.add(p);
    }
    expect([...perms].sort()).toEqual(['read', 'write']);
  });

  it('POSTs /api/keys with body scopes from --scope', async () => {
    const calls = installFetchStub({
      success: true,
      key: 'owk_live_NEW',
      keyId: 'k1',
      name: 'ci',
      environment: 'live',
      scopes: [],
      expiresAt: Date.now() + 60_000,
      keyPrefix: 'owk_live_NEWXX',
    });
    const program = buildProgram();
    await program.parseAsync(
      [
        '--json',
        'key',
        'create',
        '--name',
        'ci',
        '--scope',
        'roost=rst_testrs01234:write,deploy',
        '--scope',
        'site=*:read',
      ],
      { from: 'user' },
    );
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.scopes).toEqual([
      { resource: 'roost', id: 'rst_testrs01234', permissions: ['write', 'deploy'] },
      { resource: 'site', id: '*', permissions: ['read'] },
    ]);
  });
});

describe('owlette key rotate', () => {
  it('POSTs /api/keys/:id/rotate with ttlDays body', async () => {
    const calls = installFetchStub({
      success: true,
      key: 'owk_live_ROTATED',
      keyId: 'k-new',
      name: 'ci',
      environment: 'live',
      scopes: [],
      expiresAt: Date.now() + 60_000,
      rotatedFromKeyId: 'k-old',
      previousKey: { keyId: 'k-old', retiresAt: Date.now() + 24 * 60 * 60 * 1000 },
    });
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'key', 'rotate', 'k-old', '--ttl-days', '180'],
      { from: 'user' },
    );
    expect(calls[0]!.url).toBe('https://dev.test/api/keys/k-old/rotate');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ ttlDays: 180 });
  });
});

describe('owlette key revoke', () => {
  it('DELETEs /api/keys/:id when --yes is supplied', async () => {
    const calls = installFetchStub({ success: true });
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'key', 'revoke', 'k-doomed', '--yes'],
      { from: 'user' },
    );
    expect(calls[0]!.url).toBe('https://dev.test/api/keys/k-doomed');
    expect(calls[0]!.init.method).toBe('DELETE');
  });
});
