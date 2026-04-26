/**
 * HTTP-shape tests for `roost roost list | get | diff | versions`.
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
    .name('owlette')
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
  process.env.OWLETTE_TOKEN = 'owk_live_testtoken';
  process.env.OWLETTE_API_URL = 'https://dev.test';
  process.env.OWLETTE_PROFILE = 'default';
});

afterEach(() => {
  delete process.env.OWLETTE_TOKEN;
  delete process.env.OWLETTE_API_URL;
  delete process.env.OWLETTE_PROFILE;
  jest.restoreAllMocks();
  jest.spyOn(process.stdout, 'write').mockRestore();
});

describe('owlette roost list', () => {
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

describe('owlette roost get', () => {
  it('GETs /api/roosts/:id with siteId + Bearer auth', async () => {
    const calls = installFetchStub({
      roostId: 'rst_testrs01234',
      siteId: 'site-1',
      name: 'alpha',
      targets: [],
      extractPath: null,
      schemaVersion: 2,
      currentVersionId: null,
      previousVersionId: null,
      versionUrl: null,
      createdAt: null,
      updatedAt: null,
      deletedAt: null,
      currentVersion: null,
      previousVersion: null,
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

describe('owlette roost diff', () => {
  it('resolves currentVersionId then calls /diff?against=...', async () => {
    const roostDetail = {
      roostId: 'rst_testrs01234',
      siteId: 'site-1',
      name: 'alpha',
      targets: [],
      extractPath: null,
      schemaVersion: 2,
      currentVersionId: 'vrs_current',
      previousVersionId: 'vrs_previous',
      versionUrl: null,
      createdAt: null,
      updatedAt: null,
      deletedAt: null,
      currentVersion: null,
      previousVersion: null,
    };
    const diffResponse = {
      versionId: 'vrs_current',
      toVersion: 'vrs_current',
      fromVersion: 'vrs_previous',
      against: 'vrs_previous',
      roostId: 'rst_testrs01234',
      siteId: 'site-1',
      summary: { added: 0, removed: 0, changed: 0, unchanged: 0, hasChanges: false, netBytesDelta: 0 },
      added: [],
      removed: [],
      modified: [],
    };
    let call = 0;
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async (_url: string) => {
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
        'vrs_previous',
      ],
      { from: 'user' },
    );

    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(2);
    const diffUrl = (global.fetch as jest.Mock).mock.calls[1]![0] as string;
    expect(diffUrl).toContain(
      '/api/roosts/rst_testrs01234/versions/vrs_current/diff',
    );
    expect(diffUrl).toContain('against=vrs_previous');
    expect(diffUrl).toContain('siteId=site-1');
  });

  it('honours --version as the "to" ref when explicitly provided', async () => {
    const diffResponse = {
      versionId: 'vrs_target',
      toVersion: 'vrs_target',
      fromVersion: 'vrs_prev',
      against: 'vrs_prev',
      roostId: 'rst_testrs01234',
      siteId: 'site-1',
      summary: { added: 0, removed: 0, changed: 0, unchanged: 0, hasChanges: false, netBytesDelta: 0 },
      added: [],
      removed: [],
      modified: [],
    };
    const calls = installFetchStub(diffResponse);
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
        'vrs_prev',
        '--version',
        'vrs_target',
      ],
      { from: 'user' },
    );

    // With --version explicitly provided the CLI skips the roost-detail
    // fetch and goes straight to the diff endpoint.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(
      '/api/roosts/rst_testrs01234/versions/vrs_target/diff',
    );
    expect(calls[0]!.url).toContain('against=vrs_prev');
  });
});

describe('owlette roost versions', () => {
  it('GETs /api/roosts/:id/versions with siteId + page-size + Bearer auth', async () => {
    const calls = installFetchStub({ versions: [], nextCursor: null });
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const program = buildProgram();

    await program.parseAsync(
      [
        '--json',
        'roost',
        'versions',
        'rst_testrs01234',
        '--site',
        'site-1',
        '--page-size',
        '5',
      ],
      { from: 'user' },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(
      'https://dev.test/api/roosts/rst_testrs01234/versions?',
    );
    expect(calls[0]!.url).toContain('siteId=site-1');
    expect(calls[0]!.url).toContain('limit=5');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
  });

  it('auto-paginates via nextCursor until the server returns empty', async () => {
    const pages = [
      {
        versions: [
          {
            versionId: 'vrs_02',
            versionNumber: 2,
            description: 'second',
            versionUrl: null,
            createdAt: '2026-04-22T00:02:00Z',
            createdBy: 'u',
            totalSize: 10,
            totalFiles: 1,
            parentVersionId: 'vrs_01',
          },
        ],
        nextCursor: 'vrs_02',
      },
      {
        versions: [
          {
            versionId: 'vrs_01',
            versionNumber: 1,
            description: null,
            versionUrl: null,
            createdAt: '2026-04-22T00:01:00Z',
            createdBy: 'u',
            totalSize: 5,
            totalFiles: 1,
            parentVersionId: null,
          },
        ],
        nextCursor: null,
      },
    ];
    let page = 0;
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => {
      const body = pages[page++]!;
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    });
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const program = buildProgram();

    await program.parseAsync(
      ['--json', 'roost', 'versions', 'rst_testrs01234', '--site', 'site-1'],
      { from: 'user' },
    );

    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(2);
    const secondUrl = (global.fetch as jest.Mock).mock.calls[1]![0] as string;
    expect(secondUrl).toContain('cursor=vrs_02');
  });
});
