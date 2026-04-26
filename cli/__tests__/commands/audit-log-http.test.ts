/**
 * HTTP-shape tests for `owlette audit-log list | get`.
 */

import { Command } from 'commander';
import { registerAuditLogCommands } from '../../src/commands/audit-log';
import { _resetConfigCache } from '../../src/config';

function buildProgram(): Command {
  const program = new Command();
  program.name('owlette').exitOverride().option('--profile <name>').option('--json');
  registerAuditLogCommands(program);
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

describe('owlette audit-log list', () => {
  it('GETs /api/sites/:siteId/audit-log with siteId + limit + Bearer auth', async () => {
    const calls = installFetchStub({ siteId: 'site-1', records: [], nextPageToken: '' });
    const program = buildProgram();

    await program.parseAsync(
      ['--json', 'audit-log', 'list', '--site', 'site-1'],
      { from: 'user' },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('https://dev.test/api/sites/site-1/audit-log?');
    expect(calls[0]!.url).toContain('siteId=site-1');
    expect(calls[0]!.url).toContain('limit=50');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
  });

  it('pushes a single --kind value to the server as kind=', async () => {
    const calls = installFetchStub({ siteId: 'site-1', records: [], nextPageToken: '' });
    const program = buildProgram();

    await program.parseAsync(
      ['--json', 'audit-log', 'list', '--site', 'site-1', '--kind', 'api_key_used'],
      { from: 'user' },
    );

    expect(calls[0]!.url).toContain('kind=api_key_used');
  });

  it('does NOT push a multi-value --kind to the server (client-side filter only)', async () => {
    const calls = installFetchStub({
      siteId: 'site-1',
      records: [
        {
          hash: 'h1',
          kind: 'api_key_used',
          actor: 'u_1',
          siteId: 'site-1',
          occurredAt: 1,
          recordedAt: 1,
          attributes: {},
        },
        {
          hash: 'h2',
          kind: 'signed_url_issued',
          actor: 'u_1',
          siteId: 'site-1',
          occurredAt: 2,
          recordedAt: 2,
          attributes: {},
        },
        {
          hash: 'h3',
          kind: 'something_else',
          actor: 'u_1',
          siteId: 'site-1',
          occurredAt: 3,
          recordedAt: 3,
          attributes: {},
        },
      ],
      nextPageToken: '',
    });
    const writes: string[] = [];
    (process.stdout.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      writes.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(
      [
        '--json',
        'audit-log',
        'list',
        '--site',
        'site-1',
        '--kind',
        'api_key_used,signed_url_issued',
      ],
      { from: 'user' },
    );

    expect(calls[0]!.url).not.toContain('kind=');
    const out = JSON.parse(writes.join('')) as { records: Array<{ kind: string }> };
    const kinds = out.records.map((r) => r.kind);
    expect(kinds).toEqual(['api_key_used', 'signed_url_issued']);
  });

  it('converts --since 24h to an ISO 8601 query param', async () => {
    const calls = installFetchStub({ siteId: 'site-1', records: [], nextPageToken: '' });
    const program = buildProgram();

    await program.parseAsync(
      ['--json', 'audit-log', 'list', '--site', 'site-1', '--since', '24h'],
      { from: 'user' },
    );

    expect(calls[0]!.url).toMatch(/since=\d{4}-\d{2}-\d{2}T\d{2}%3A\d{2}%3A\d{2}/);
  });

  it('starts from --cursor when provided', async () => {
    const calls = installFetchStub({ siteId: 'site-1', records: [], nextPageToken: '' });
    const program = buildProgram();

    await program.parseAsync(
      ['--json', 'audit-log', 'list', '--site', 'site-1', '--cursor', 'tok_42'],
      { from: 'user' },
    );

    expect(calls[0]!.url).toContain('cursor=tok_42');
  });
});

describe('owlette audit-log get', () => {
  it('GETs /api/sites/:siteId/audit-log/:recordHash with Bearer auth', async () => {
    const calls = installFetchStub({
      siteId: 'site-1',
      hash: 'h1',
      previousHash: 'h0',
      recordedAt: 1,
      event: { kind: 'api_key_used', siteId: 'site-1', actor: 'u_1', occurredAt: 1, attributes: {} },
      verification: { ok: true, hashValid: true, linkageValid: true, isGenesis: false, predecessorPresent: true, reason: null },
    });
    const program = buildProgram();

    await program.parseAsync(
      ['--json', 'audit-log', 'get', 'h1', '--site', 'site-1'],
      { from: 'user' },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://dev.test/api/sites/site-1/audit-log/h1');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
  });
});
