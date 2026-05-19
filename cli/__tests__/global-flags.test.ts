/**
 * Tests for the program-level global flags wired in `cli/src/index.ts`:
 *   --api-url <url>   (env: OWLETTE_API_URL)
 *   --profile <name>  (env: OWLETTE_PROFILE)
 *   --json            (per-command flag, no env)
 *
 * The `--api-url` flag is implemented via a `preAction` hook that
 * promotes the parsed value into `process.env.OWLETTE_API_URL` so
 * `loadConfig` and every command's `resolveAuth` pick it up without
 * per-file wiring. These tests assert that hook actually fires and that
 * the flag overrides any pre-existing env value.
 */

import { buildProgram } from '../src/index';
import { _resetConfigCache } from '../src/config';

interface FetchCall {
  url: string;
}

function installFetchStub(payload: unknown, status = 200): FetchCall[] {
  const calls: FetchCall[] = [];
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async (url: string) => {
    calls.push({ url });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as Response;
  });
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

describe('--api-url global flag', () => {
  it('routes the request to the flag value, not the env var', async () => {
    process.env.OWLETTE_API_URL = 'https://env-url.test';
    const calls = installFetchStub({ current: '2026-04-22', supported: ['2026-04-22'] });
    const program = buildProgram();

    await program.parseAsync(
      ['--api-url', 'https://flag-url.test', 'version'],
      { from: 'user' },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://flag-url.test/api/version');
    expect(calls[0]!.url).not.toContain('env-url.test');
  });

  it('falls back to OWLETTE_API_URL env var when --api-url is omitted', async () => {
    process.env.OWLETTE_API_URL = 'https://env-only.test';
    const calls = installFetchStub({ current: '2026-04-22', supported: ['2026-04-22'] });
    const program = buildProgram();

    await program.parseAsync(['version'], { from: 'user' });

    expect(calls[0]!.url).toBe('https://env-only.test/api/version');
  });
});
