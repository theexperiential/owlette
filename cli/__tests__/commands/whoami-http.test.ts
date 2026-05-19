/**
 * HTTP-shape tests for `owlette whoami` (and the `auth status` alias).
 */

import { Command } from 'commander';
import { registerWhoamiCommand } from '../../src/commands/whoami';
import { registerAuthCommands } from '../../src/commands/auth';
import { _resetConfigCache } from '../../src/config';

function buildProgram(): Command {
  const program = new Command();
  program.name('owlette').exitOverride().option('--profile <name>').option('--json');
  registerWhoamiCommand(program);
  registerAuthCommands(program);
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
  jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  delete process.env.OWLETTE_TOKEN;
  delete process.env.OWLETTE_API_URL;
  delete process.env.OWLETTE_PROFILE;
  process.exitCode = 0;
  jest.restoreAllMocks();
});

const WHOAMI = {
  userId: 'u_1',
  email: 'dylan@roscover.com',
  role: 'admin',
  key: {
    keyId: 'k_1',
    name: 'cli-test',
    keyPrefix: 'owk_live_xxxx',
    scopes: [{ resource: 'site', id: '*', permissions: ['read'] }],
    environment: 'live',
    expiresAt: null,
    lastUsedAt: null,
    isLegacy: false,
  },
  rateLimit: null,
  quota: null,
  primarySiteId: 'site-1',
};

describe('owlette whoami', () => {
  it('GETs /api/whoami with Bearer auth', async () => {
    const calls = installFetchStub(WHOAMI);
    const program = buildProgram();

    await program.parseAsync(['whoami'], { from: 'user' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://dev.test/api/whoami');
    expect((calls[0]!.init.method ?? 'GET').toUpperCase()).toBe('GET');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
  });

  it('emits the {apiUrl, profile, configPath, environment, whoami} envelope in --json mode', async () => {
    installFetchStub(WHOAMI);
    const writes: string[] = [];
    (process.stdout.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      writes.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(['--json', 'whoami'], { from: 'user' });

    const parsed = JSON.parse(writes.join('')) as Record<string, unknown>;
    expect(parsed.whoami).toEqual(WHOAMI);
    expect(parsed.apiUrl).toBe('https://dev.test');
    expect(parsed.profile).toBe('default');
  });

  it('exits with code 2 when no token is configured (no fetch made)', async () => {
    delete process.env.OWLETTE_TOKEN;
    _resetConfigCache();
    const calls = installFetchStub(WHOAMI);
    const program = buildProgram();

    await program.parseAsync(['whoami'], { from: 'user' });

    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBe(2);
  });

  it('exits with code 1 on a non-2xx response', async () => {
    installFetchStub({ detail: 'unauthorized' }, 401);
    const program = buildProgram();

    await program.parseAsync(['whoami'], { from: 'user' });

    expect(process.exitCode).toBe(1);
  });
});

describe('owlette auth status (alias of whoami)', () => {
  it('routes through the same /api/whoami fetch and emits identical JSON', async () => {
    installFetchStub(WHOAMI);
    const writes: string[] = [];
    (process.stdout.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      writes.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(['--json', 'auth', 'status'], { from: 'user' });

    const parsed = JSON.parse(writes.join('')) as Record<string, unknown>;
    expect(parsed.whoami).toEqual(WHOAMI);
    expect(parsed.profile).toBe('default');
  });
});
