/**
 * HTTP-shape tests for `owlette machine list | get | deployments`.
 */

import { Command } from 'commander';
import { registerMachineCommands } from '../../src/commands/machine';
import { _resetConfigCache } from '../../src/config';

function buildProgram(): Command {
  const program = new Command();
  program.name('owlette').exitOverride().option('--profile <name>').option('--json');
  registerMachineCommands(program);
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

describe('owlette machine list', () => {
  it('GETs /api/sites/:siteId/machines with Bearer auth', async () => {
    const calls = installFetchStub({ machines: [] });
    const program = buildProgram();

    await program.parseAsync(['--json', 'machine', 'list', '--site', 'site-1'], { from: 'user' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://dev.test/api/sites/site-1/machines');
    expect((calls[0]!.init.method ?? 'GET').toUpperCase()).toBe('GET');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
  });

  it('emits {machines: [...]} envelope in --json mode', async () => {
    const machines = [
      {
        id: 'm-1',
        name: 'kiosk-01',
        online: true,
        lastHeartbeat: '2026-04-26T00:00:00Z',
        agentVersion: '2.11.0',
        os: 'win11',
        currentRoosts: [],
      },
    ];
    installFetchStub({ machines });
    const writes: string[] = [];
    (process.stdout.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      writes.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(['--json', 'machine', 'list', '--site', 'site-1'], { from: 'user' });

    expect(JSON.parse(writes.join(''))).toEqual({ machines });
  });
});

describe('owlette machine get', () => {
  it('GETs /api/sites/:siteId/machines/:machineId with Bearer auth', async () => {
    const calls = installFetchStub({
      id: 'm-1',
      siteId: 'site-1',
      name: 'kiosk-01',
      online: true,
      lastHeartbeat: null,
      agentVersion: null,
      os: null,
      hostname: null,
      metrics: null,
      processes: [],
    });
    const program = buildProgram();

    await program.parseAsync(
      ['--json', 'machine', 'get', 'm-1', '--site', 'site-1'],
      { from: 'user' },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://dev.test/api/sites/site-1/machines/m-1');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
  });
});

describe('owlette machine deployments', () => {
  it('GETs /api/sites/:siteId/machines/:machineId/deployments with Bearer auth', async () => {
    const calls = installFetchStub({ siteId: 'site-1', machineId: 'm-1', deployments: [] });
    const program = buildProgram();

    await program.parseAsync(
      ['--json', 'machine', 'deployments', 'm-1', '--site', 'site-1'],
      { from: 'user' },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://dev.test/api/sites/site-1/machines/m-1/deployments');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
  });

  it('round-trips the full deployments response in --json mode', async () => {
    const payload = {
      siteId: 'site-1',
      machineId: 'm-1',
      deployments: [
        {
          roostId: 'rst_a',
          name: 'alpha',
          currentVersionId: 'vrs_02',
          previousVersionId: 'vrs_01',
          versionCounter: 2,
          extractPath: '~/x',
          reportedVersionId: 'vrs_02',
          reportedStatus: 'ok',
          reportedAt: '2026-04-26T00:00:00Z',
        },
      ],
    };
    installFetchStub(payload);
    const writes: string[] = [];
    (process.stdout.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      writes.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(
      ['--json', 'machine', 'deployments', 'm-1', '--site', 'site-1'],
      { from: 'user' },
    );

    expect(JSON.parse(writes.join(''))).toEqual(payload);
  });
});
