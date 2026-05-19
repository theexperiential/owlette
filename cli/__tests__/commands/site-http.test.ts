/**
 * HTTP-shape tests for `owlette site list | get`.
 *
 * Intercepts global.fetch, builds an in-process commander program, and
 * asserts the request URL/method/headers/body match the contract.
 */

import { Command } from 'commander';
import { registerSiteCommands } from '../../src/commands/site';
import { _resetConfigCache } from '../../src/config';

function buildProgram(): Command {
  const program = new Command();
  program.name('owlette').exitOverride().option('--profile <name>').option('--json');
  registerSiteCommands(program);
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
  jest.restoreAllMocks();
});

describe('owlette site list', () => {
  it('GETs /api/sites with Bearer auth', async () => {
    const calls = installFetchStub({ sites: [] });
    const program = buildProgram();

    await program.parseAsync(['--json', 'site', 'list'], { from: 'user' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://dev.test/api/sites');
    expect((calls[0]!.init.method ?? 'GET').toUpperCase()).toBe('GET');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
  });

  it('emits {sites: [...]} envelope in --json mode', async () => {
    const sites = [
      { id: 'site-1', name: 'alpha', plan: 'pro', timezone: 'utc', owner: null, createdAt: null },
      { id: 'site-2', name: 'beta', plan: null, timezone: null, owner: null, createdAt: null },
    ];
    installFetchStub({ sites });
    const writes: string[] = [];
    (process.stdout.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      writes.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(['--json', 'site', 'list'], { from: 'user' });

    const out = writes.join('');
    const parsed = JSON.parse(out) as { sites: typeof sites };
    expect(parsed.sites).toEqual(sites);
  });

  it('renders an ascii table in default mode', async () => {
    installFetchStub({
      sites: [
        { id: 'site-1', name: 'alpha', plan: 'pro', timezone: 'utc', owner: null, createdAt: null },
      ],
    });
    const writes: string[] = [];
    (process.stdout.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      writes.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(['site', 'list'], { from: 'user' });

    const out = writes.join('');
    expect(out).toContain('id');
    expect(out).toContain('site-1');
    expect(out).toContain('alpha');
  });
});

describe('owlette site get', () => {
  it('GETs /api/sites/:siteId with Bearer auth', async () => {
    const calls = installFetchStub({
      id: 'site-1',
      name: 'alpha',
      plan: 'pro',
      timezone: 'utc',
      owner: null,
      createdAt: null,
    });
    const program = buildProgram();

    await program.parseAsync(['--json', 'site', 'get', 'site-1'], { from: 'user' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://dev.test/api/sites/site-1');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
  });

  it('round-trips the raw detail in --json mode', async () => {
    const detail = {
      id: 'site-1',
      name: 'alpha',
      plan: 'pro',
      timezone: 'utc',
      owner: 'u_1',
      createdAt: '2026-01-01T00:00:00Z',
    };
    installFetchStub(detail);
    const writes: string[] = [];
    (process.stdout.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      writes.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(['--json', 'site', 'get', 'site-1'], { from: 'user' });

    const out = writes.join('');
    expect(JSON.parse(out)).toEqual(detail);
  });
});
