/**
 * HTTP-shape tests for `owlette quota show | history`.
 */

import { Command } from 'commander';
import { registerQuotaCommands } from '../../src/commands/quota';
import { _resetConfigCache } from '../../src/config';

function buildProgram(): Command {
  const program = new Command();
  program.name('owlette').exitOverride().option('--profile <name>').option('--json');
  registerQuotaCommands(program);
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

const SNAPSHOT = {
  siteId: 'site-1',
  tier: 'pro',
  usedBytes: 1024,
  pendingBytes: 0,
  committedBytes: 1024,
  limitBytes: 5 * 1024 * 1024 * 1024,
  fractionUsed: 0.0001,
  unlimited: false,
  lastAlarmLevel: 0,
  lastAlarmAt: null,
  lastReconciledAt: '2026-04-26T00:00:00Z',
  alarms: [],
};

describe('owlette quota show', () => {
  it('GETs /api/sites/:siteId/quota with Bearer auth', async () => {
    const calls = installFetchStub(SNAPSHOT);
    const program = buildProgram();

    await program.parseAsync(['--json', 'quota', 'show', '--site', 'site-1'], { from: 'user' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://dev.test/api/sites/site-1/quota');
    expect((calls[0]!.init.method ?? 'GET').toUpperCase()).toBe('GET');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
  });

  it('round-trips the full snapshot in --json mode', async () => {
    installFetchStub(SNAPSHOT);
    const writes: string[] = [];
    (process.stdout.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      writes.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(['--json', 'quota', 'show', '--site', 'site-1'], { from: 'user' });

    expect(JSON.parse(writes.join(''))).toEqual(SNAPSHOT);
  });

  it('renders a progress bar with percent in default mode', async () => {
    installFetchStub({ ...SNAPSHOT, usedBytes: 2.5 * 1024 * 1024 * 1024, committedBytes: 2.5 * 1024 * 1024 * 1024 });
    const writes: string[] = [];
    (process.stdout.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      writes.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(['quota', 'show', '--site', 'site-1'], { from: 'user' });

    const out = writes.join('');
    expect(out).toContain('storage:');
    expect(out).toMatch(/\(\d+%\)/);
    expect(out).toMatch(/\[#+\.+\]/);
  });
});

describe('owlette quota history', () => {
  it('defaults to period=30d when --period is not supplied', async () => {
    const calls = installFetchStub({ siteId: 'site-1', period: '30d', days: 30, daily: [] });
    const program = buildProgram();

    await program.parseAsync(['--json', 'quota', 'history', '--site', 'site-1'], { from: 'user' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://dev.test/api/sites/site-1/quota/history?period=30d');
  });

  it('honours --period and round-trips full history in --json mode', async () => {
    const history = {
      siteId: 'site-1',
      period: '7d',
      days: 7,
      daily: [
        { date: '2026-04-20', storageBytesAvg: 1024, classAOps: 5, classBOps: 50, egressBytes: 2048 },
      ],
    };
    const calls = installFetchStub(history);
    const writes: string[] = [];
    (process.stdout.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      writes.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(
      ['--json', 'quota', 'history', '--site', 'site-1', '--period', '7d'],
      { from: 'user' },
    );

    expect(calls[0]!.url).toBe('https://dev.test/api/sites/site-1/quota/history?period=7d');
    expect(JSON.parse(writes.join(''))).toEqual(history);
  });

  it('exits 2 when --period is invalid', async () => {
    const calls = installFetchStub({ siteId: 'site-1', period: '30d', days: 30, daily: [] });
    const program = buildProgram();

    await program.parseAsync(
      ['quota', 'history', '--site', 'site-1', '--period', 'banana'],
      { from: 'user' },
    );

    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
  });
});
