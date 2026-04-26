import { Command } from 'commander';
import { registerDeployCommand } from '../../src/commands/deploy';
import { _resetConfigCache } from '../../src/config';

function buildProgram(): Command {
  const program = new Command();
  program.name('owlette').exitOverride().option('--profile <name>').option('--json');
  registerDeployCommand(program);
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

describe('owlette deploy (dry-run)', () => {
  it('POSTs /api/roosts/:id/deploy with dryRun:true and no idempotency key', async () => {
    const calls = installFetchStub({
      rolloutId: 'vrs_01',
      versionId: 'vrs_01',
      siteId: 'site-1',
      roostId: 'rst_testrs01234',
      stage: 'canary',
      canary: ['m-1'],
      fleet: ['m-2'],
      extractRoot: '~/x',
      versionUrl: 'https://r2/.../vrs_01.json',
      dryRun: true,
    });
    const program = buildProgram();
    await program.parseAsync(
      [
        '--json',
        'deploy',
        'rst_testrs01234',
        '--site',
        'site-1',
        '--dry-run',
      ],
      { from: 'user' },
    );
    expect(calls[0]!.url).toBe('https://dev.test/api/roosts/rst_testrs01234/deploy');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
    expect(headers['Idempotency-Key']).toBeUndefined();
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.siteId).toBe('site-1');
    expect(body.dryRun).toBe(true);
  });

  it('adds an auto Idempotency-Key for real deploys', async () => {
    const calls = installFetchStub({
      rolloutId: 'vrs_01',
      versionId: 'vrs_01',
      siteId: 'site-1',
      roostId: 'rst_testrs01234',
      stage: 'canary',
      canary: ['m-1'],
      fleet: [],
      extractRoot: '~/x',
      versionUrl: 'https://r2/.../vrs_01.json',
    });
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'deploy', 'rst_testrs01234', '--site', 'site-1'],
      { from: 'user' },
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^cli-deploy-/);
  });

  it('respects --version, --machines and --at overrides', async () => {
    const calls = installFetchStub({
      rolloutId: 'vrs_01',
      versionId: 'vrs_01',
      siteId: 'site-1',
      roostId: 'rst_testrs01234',
      stage: 'scheduled',
      canary: [],
      fleet: [],
      extractRoot: '~/x',
      versionUrl: 'https://r2/.../vrs_01.json',
    });
    const program = buildProgram();
    await program.parseAsync(
      [
        '--json',
        'deploy',
        'rst_testrs01234',
        '--site',
        'site-1',
        '--version',
        'vrs_01',
        '--machines',
        'm-1,m-2',
        '--at',
        '2026-05-01T00:00:00Z',
      ],
      { from: 'user' },
    );
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.versionId).toBe('vrs_01');
    expect(body.machines).toEqual(['m-1', 'm-2']);
    expect(body.scheduleAt).toBe('2026-05-01T00:00:00.000Z');
  });
});
