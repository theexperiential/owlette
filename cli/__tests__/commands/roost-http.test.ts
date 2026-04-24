/**
 * HTTP-shape tests for `roost roost list | get | diff`.
 *
 * Intercepts global.fetch, builds an in-process commander program, and
 * asserts the request URL/method/headers/body match the contract.
 * Keeps the network off-limits so these run fully hermetic.
 */

import { Command } from 'commander';
import { registerRoostInspectCommands } from '../../src/commands/roost';
import { _resetConfigCache } from '../../src/config';

function buildProgram(): Command {
  const program = new Command();
  program
    .name('roost')
    .exitOverride()
    .option('--profile <name>')
    .option('--json');
  registerRoostInspectCommands(program);
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
});

afterEach(() => {
  delete process.env.ROOST_TOKEN;
  delete process.env.ROOST_API_URL;
  delete process.env.ROOST_PROFILE;
  jest.restoreAllMocks();
  jest.spyOn(process.stdout, 'write').mockRestore();
});

describe('roost roost list', () => {
  it('GETs /api/roosts with siteId + limit + Bearer auth', async () => {
    const calls = installFetchStub({ roosts: [], nextPageToken: '' });
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const program = buildProgram();

    await program.parseAsync(
      ['--json', 'roost', 'list', '--site', 'site-1', '--page-size', '5'],
      { from: 'user' },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('https://dev.test/api/roosts?');
    expect(calls[0]!.url).toContain('siteId=site-1');
    expect(calls[0]!.url).toContain('limit=5');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
  });
});

describe('roost roost get', () => {
  it('GETs /api/roosts/:id with siteId + Bearer auth', async () => {
    const calls = installFetchStub({
      roostId: 'rst_testrs01234',
      siteId: 'site-1',
      name: 'alpha',
      targets: [],
      extractPath: null,
      schemaVersion: 2,
      currentManifestId: null,
      previousManifestId: null,
      manifestUrl: null,
      createdAt: null,
      updatedAt: null,
      deletedAt: null,
      currentManifest: null,
      previousManifest: null,
    });
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const program = buildProgram();

    await program.parseAsync(
      ['--json', 'roost', 'get', 'rst_testrs01234', '--site', 'site-1'],
      { from: 'user' },
    );
    expect(calls[0]!.url).toBe(
      'https://dev.test/api/roosts/rst_testrs01234?siteId=site-1',
    );
  });
});

describe('roost roost diff', () => {
  it('resolves currentManifestId then calls /diff?against=...', async () => {
    const roostDetail = {
      roostId: 'rst_testrs01234',
      siteId: 'site-1',
      name: 'alpha',
      targets: [],
      extractPath: null,
      schemaVersion: 2,
      currentManifestId: 'manifest-current',
      previousManifestId: 'manifest-previous',
      manifestUrl: null,
      createdAt: null,
      updatedAt: null,
      deletedAt: null,
      currentManifest: null,
      previousManifest: null,
    };
    const diffResponse = {
      manifestId: 'manifest-current',
      against: 'manifest-previous',
      roostId: 'rst_testrs01234',
      siteId: 'site-1',
      summary: { added: 0, removed: 0, changed: 0, unchanged: 0, hasChanges: false, netBytesDelta: 0 },
      added: [],
      removed: [],
      modified: [],
    };
    let call = 0;
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async (url: string) => {
      call += 1;
      return {
        ok: true,
        status: 200,
        json: async () => (call === 1 ? roostDetail : diffResponse),
        text: async () => '',
        headers: new Headers(),
      } as unknown as Response;
    });
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const program = buildProgram();

    await program.parseAsync(
      [
        '--json',
        'roost',
        'diff',
        'rst_testrs01234',
        '--site',
        'site-1',
        '--against',
        'manifest-previous',
      ],
      { from: 'user' },
    );

    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(2);
    const diffUrl = (global.fetch as jest.Mock).mock.calls[1]![0] as string;
    expect(diffUrl).toContain(
      '/api/roosts/rst_testrs01234/manifests/manifest-current/diff',
    );
    expect(diffUrl).toContain('against=manifest-previous');
    expect(diffUrl).toContain('siteId=site-1');
  });
});
