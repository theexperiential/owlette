/**
 * HTTP-shape tests for `owlette version`.
 */

import { Command } from 'commander';
import { registerVersionCommand } from '../../src/commands/version';
import { _resetConfigCache } from '../../src/config';

function buildProgram(): Command {
  const program = new Command();
  program.name('owlette').exitOverride().option('--profile <name>').option('--json');
  registerVersionCommand(program);
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

const VERSION_RESPONSE = {
  current: '2026-04-22',
  supported: ['2026-01-01', '2026-02-15', '2026-04-22'],
};

describe('owlette version', () => {
  it('GETs /api/version with Accept + Bearer headers', async () => {
    const calls = installFetchStub(VERSION_RESPONSE);
    const program = buildProgram();

    await program.parseAsync(['version'], { from: 'user' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://dev.test/api/version');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer owk_live_testtoken',
    });
  });

  it('emits {cli, server, supportedVersions, minimumVersion} envelope in --json mode', async () => {
    installFetchStub(VERSION_RESPONSE);
    const writes: string[] = [];
    (process.stdout.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      writes.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(['--json', 'version'], { from: 'user' });

    const parsed = JSON.parse(writes.join('')) as Record<string, unknown>;
    expect(parsed.server).toBe('2026-04-22');
    expect(parsed.supportedVersions).toEqual(VERSION_RESPONSE.supported);
    expect(parsed.minimumVersion).toBe('2026-01-01');
    expect(parsed).not.toHaveProperty('pinned');
    expect(typeof parsed.cli).toBe('string');
  });
});
