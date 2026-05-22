/**
 * HTTP-shape tests for the wave-2A machine mutation verbs:
 *   `owlette machine reboot | shutdown | screenshot`
 *
 * Drives:
 *   POST /api/sites/:siteId/machines/:machineId/commands
 *   GET  /api/sites/:siteId/machines/:machineId/commands/:commandId  (screenshot polling)
 *
 * Properties asserted:
 *   - reboot/shutdown send {type, params:{delay_seconds?}} with an
 *     auto-generated Idempotency-Key
 *   - 409 machine_offline surfaces the canonical hint
 *   - screenshot is a queue → poll → download flow:
 *       * POST returns commandId + status=pending
 *       * GET commands/:id polled until status=completed
 *       * the signed `screenshot_url` from `result` is fetched and the
 *         bytes written to `--output <path>` (or default filename)
 *   - the screenshot polling loop bails on status=failed
 *   - the screenshot polling loop times out after MAX_ATTEMPTS attempts
 *     (we exercise the timeout by stubbing every poll to return pending)
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { registerMachineCommands } from '../../src/commands/machine';
import { _resetConfigCache } from '../../src/config';
import { _internals as machineInternals } from '../../src/commands/machine';

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

function installFetchStub(
  responder: (call: FetchCall, idx: number) => { status: number; payload: unknown; bodyBytes?: Buffer },
): FetchCall[] {
  const calls: FetchCall[] = [];
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(
    async (url: string, init: RequestInit = {}) => {
      const call: FetchCall = { url, init };
      calls.push(call);
      const idx = calls.length - 1;
      const response = responder(call, idx);
      const status = response.status;
      const payload = response.payload;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
        arrayBuffer: async () =>
          response.bodyBytes
            ? response.bodyBytes.buffer.slice(
                response.bodyBytes.byteOffset,
                response.bodyBytes.byteOffset + response.bodyBytes.byteLength,
              )
            : new ArrayBuffer(0),
      } as Response;
    },
  );
  return calls;
}

let originalFetch: typeof global.fetch;
let originalSetTimeout: typeof setTimeout;
beforeAll(() => {
  originalFetch = global.fetch;
  originalSetTimeout = global.setTimeout;
});
afterAll(() => {
  global.fetch = originalFetch;
  global.setTimeout = originalSetTimeout;
});

beforeEach(() => {
  _resetConfigCache();
  process.env.OWLETTE_TOKEN = 'owk_live_testtoken';
  process.env.OWLETTE_API_URL = 'https://dev.test';
  process.env.OWLETTE_PROFILE = 'default';
  process.exitCode = 0;
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  // The screenshot polling loop sleeps between attempts. Replace
  // setTimeout with an immediate scheduler so tests don't actually
  // wait 60s on a timeout case.
  (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
    fn: (...args: unknown[]) => void,
    _ms?: number,
    ...rest: unknown[]
  ) => {
    fn(...rest);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
});

afterEach(() => {
  delete process.env.OWLETTE_TOKEN;
  delete process.env.OWLETTE_API_URL;
  delete process.env.OWLETTE_PROFILE;
  process.exitCode = 0;
  jest.restoreAllMocks();
});

const COMMANDS_URL = 'https://dev.test/api/sites/site-1/machines/m-1/commands';

/* -------------------------------------------------------------------- */
/*  reboot / shutdown                                                    */
/* -------------------------------------------------------------------- */

describe.each([
  ['reboot', 'reboot_machine'],
  ['shutdown', 'shutdown_machine'],
] as const)('owlette machine %s', (verb, commandType) => {
  it(`POSTs /commands with body {type:'${commandType}', params:{}} and an Idempotency-Key`, async () => {
    const calls = installFetchStub(() => ({
      status: 202,
      payload: { ok: true, data: { commandId: 'cmd_abc', status: 'pending' } },
    }));
    const program = buildProgram();

    await program.parseAsync(
      ['--json', 'machine', verb, 'm-1', '--site', 'site-1'],
      { from: 'user' },
    );

    expect(calls[0]!.url).toBe(COMMANDS_URL);
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(new RegExp(`^cli-machine-${verb}-`));
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({ type: commandType, params: {} });
  });

  it('forwards --delay-seconds as params.delay_seconds', async () => {
    const calls = installFetchStub(() => ({
      status: 202,
      payload: { ok: true, data: { commandId: 'cmd_abc', status: 'pending' } },
    }));
    const program = buildProgram();

    await program.parseAsync(
      [
        '--json',
        'machine',
        verb,
        'm-1',
        '--site',
        'site-1',
        '--delay-seconds',
        '30',
      ],
      { from: 'user' },
    );

    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({ type: commandType, params: { delay_seconds: 30 } });
  });

  it('surfaces 409 machine_offline with the canonical hint', async () => {
    installFetchStub(() => ({
      status: 409,
      payload: {
        type: 'about:blank',
        title: 'machine offline',
        status: 409,
        code: 'machine_offline',
        detail: 'machine m-1 is currently offline; commands cannot be queued until it reconnects',
      },
    }));
    const stderr: string[] = [];
    (process.stderr.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      stderr.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(
      ['machine', verb, 'm-1', '--site', 'site-1'],
      { from: 'user' },
    );

    const errOut = stderr.join('');
    expect(errOut).toContain('code=machine_offline');
    expect(errOut).toContain('machine appears offline; check the dashboard heartbeat');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

/* -------------------------------------------------------------------- */
/*  screenshot                                                           */
/* -------------------------------------------------------------------- */

describe('owlette machine screenshot', () => {
  it('queues the command, polls, downloads to --output, prints saved path', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'owlette-screenshot-'));
    const outPath = path.join(tmpDir, 'shot.png');
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const signedUrl = 'https://signed.test/shot.png?token=abc';

    const calls = installFetchStub((call) => {
      // POST queue
      if (call.url === COMMANDS_URL) {
        return {
          status: 202,
          payload: { ok: true, data: { commandId: 'cmd_xyz', status: 'pending' } },
        };
      }
      // GET poll
      if (call.url.endsWith('/commands/cmd_xyz')) {
        return {
          status: 200,
          payload: {
            ok: true,
            data: {
              commandId: 'cmd_xyz',
              status: 'completed',
              result: { screenshot_url: signedUrl },
            },
          },
        };
      }
      // GET signed url → png bytes
      if (call.url === signedUrl) {
        return { status: 200, payload: {}, bodyBytes: pngBytes };
      }
      throw new Error(`unexpected fetch url ${call.url}`);
    });
    const program = buildProgram();

    await program.parseAsync(
      [
        '--json',
        'machine',
        'screenshot',
        'm-1',
        '--site',
        'site-1',
        '--monitor',
        '1',
        '--output',
        outPath,
      ],
      { from: 'user' },
    );

    // 3 fetches: POST queue, GET poll, GET signed
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toBe(COMMANDS_URL);
    expect(calls[0]!.init.method).toBe('POST');
    const queueBody = JSON.parse(String(calls[0]!.init.body));
    expect(queueBody).toEqual({
      type: 'capture_screenshot',
      params: { monitor: 1 },
    });
    expect(calls[1]!.url).toBe(`${COMMANDS_URL}/cmd_xyz`);
    expect((calls[1]!.init.method ?? 'GET').toUpperCase()).toBe('GET');
    expect(calls[2]!.url).toBe(signedUrl);

    const written = await fsp.readFile(outPath);
    expect(written.equals(pngBytes)).toBe(true);

    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('parses --monitor as integer index when numeric', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'owlette-screenshot-'));
    const outPath = path.join(tmpDir, 'shot.png');
    const pngBytes = Buffer.from([0x89]);
    const signedUrl = 'https://signed.test/x.png';

    const calls = installFetchStub((call) => {
      if (call.url === COMMANDS_URL) {
        return {
          status: 202,
          payload: { ok: true, data: { commandId: 'cmd_xyz', status: 'pending' } },
        };
      }
      if (call.url.endsWith('/commands/cmd_xyz')) {
        return {
          status: 200,
          payload: {
            ok: true,
            data: {
              commandId: 'cmd_xyz',
              status: 'completed',
              result: { screenshot_url: signedUrl },
            },
          },
        };
      }
      if (call.url === signedUrl) {
        return { status: 200, payload: {}, bodyBytes: pngBytes };
      }
      throw new Error(`unexpected fetch url ${call.url}`);
    });
    const program = buildProgram();

    await program.parseAsync(
      [
        '--json',
        'machine',
        'screenshot',
        'm-1',
        '--site',
        'site-1',
        '--monitor',
        '2',
        '--output',
        outPath,
      ],
      { from: 'user' },
    );

    const queueBody = JSON.parse(String(calls[0]!.init.body));
    expect(queueBody).toEqual({
      type: 'capture_screenshot',
      params: { monitor: 2 },
    });

    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('uses the default filename in cwd when --output is omitted', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'owlette-screenshot-cwd-'));
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const pngBytes = Buffer.from([0x89, 0x50]);
      const signedUrl = 'https://signed.test/default.png';

      installFetchStub((call) => {
        if (call.url === COMMANDS_URL) {
          return {
            status: 202,
            payload: { ok: true, data: { commandId: 'cmd_xyz', status: 'pending' } },
          };
        }
        if (call.url.endsWith('/commands/cmd_xyz')) {
          return {
            status: 200,
            payload: {
              ok: true,
              data: {
                commandId: 'cmd_xyz',
                status: 'completed',
                result: { screenshot_url: signedUrl },
              },
            },
          };
        }
        if (call.url === signedUrl) {
          return { status: 200, payload: {}, bodyBytes: pngBytes };
        }
        throw new Error(`unexpected fetch url ${call.url}`);
      });
      const program = buildProgram();

      await program.parseAsync(
        ['--json', 'machine', 'screenshot', 'm-1', '--site', 'site-1'],
        { from: 'user' },
      );

      // The default filename is `screenshot-<machineId>-<ts>.png`.
      const written = fs
        .readdirSync(tmpDir)
        .filter((f) => f.startsWith('screenshot-m-1-') && f.endsWith('.png'));
      expect(written.length).toBe(1);
    } finally {
      process.chdir(originalCwd);
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('surfaces a useful error and exits 1 when the agent fails the capture', async () => {
    installFetchStub((call) => {
      if (call.url === COMMANDS_URL) {
        return {
          status: 202,
          payload: { ok: true, data: { commandId: 'cmd_fail', status: 'pending' } },
        };
      }
      return {
        status: 200,
        payload: {
          ok: true,
          data: { commandId: 'cmd_fail', status: 'failed', error: 'no display attached' },
        },
      };
    });
    const stderr: string[] = [];
    (process.stderr.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      stderr.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(
      ['machine', 'screenshot', 'm-1', '--site', 'site-1'],
      { from: 'user' },
    );

    const errOut = stderr.join('');
    expect(errOut).toContain('screenshot capture failed on the agent');
    expect(errOut).toContain('no display attached');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('surfaces screenshot read+write scope hint on scope_insufficient', async () => {
    installFetchStub(() => ({
      status: 403,
      payload: {
        type: 'about:blank',
        title: 'scope_insufficient',
        status: 403,
        code: 'scope_insufficient',
        detail: 'API key is missing machine=m-1:write scope',
      },
    }));
    const stderr: string[] = [];
    (process.stderr.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      stderr.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(
      ['machine', 'screenshot', 'm-1', '--site', 'site-1'],
      { from: 'user' },
    );

    const errOut = stderr.join('');
    expect(errOut).toContain('code=scope_insufficient');
    expect(errOut).toContain('screenshot requires both machine=<id>:write and machine=<id>:read scopes');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('times out and exits 1 after MAX_ATTEMPTS poll attempts of pending status', async () => {
    const calls = installFetchStub((call, idx) => {
      if (idx === 0) {
        // POST queue
        return {
          status: 202,
          payload: { ok: true, data: { commandId: 'cmd_slow', status: 'pending' } },
        };
      }
      // every poll returns pending forever
      return {
        status: 200,
        payload: { ok: true, data: { commandId: 'cmd_slow', status: 'pending' } },
      };
    });
    const stderr: string[] = [];
    (process.stderr.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      stderr.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(
      ['machine', 'screenshot', 'm-1', '--site', 'site-1'],
      { from: 'user' },
    );

    // 1 POST + MAX_ATTEMPTS polls
    expect(calls.length).toBe(1 + machineInternals.SCREENSHOT_POLL_MAX_ATTEMPTS);
    const errOut = stderr.join('');
    expect(errOut).toContain('screenshot timed out');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('rejects an invalid --monitor value before issuing http', async () => {
    const calls = installFetchStub(() => ({
      status: 202,
      payload: { ok: true, data: { commandId: 'cmd_xyz', status: 'pending' } },
    }));
    const program = buildProgram();

    await program.parseAsync(
      [
        'machine',
        'screenshot',
        'm-1',
        '--site',
        'site-1',
        '--monitor',
        'banana',
      ],
      { from: 'user' },
    );

    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBe(2);
  });

  it('rejects named --monitor values before issuing http', async () => {
    const calls = installFetchStub(() => ({
      status: 202,
      payload: { ok: true, data: { commandId: 'cmd_xyz', status: 'pending' } },
    }));
    const program = buildProgram();

    await program.parseAsync(
      [
        'machine',
        'screenshot',
        'm-1',
        '--site',
        'site-1',
        '--monitor',
        'primary',
      ],
      { from: 'user' },
    );

    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBe(2);
  });
});

/* -------------------------------------------------------------------- */
/*  helper-shape unit tests                                              */
/* -------------------------------------------------------------------- */

describe('machine helpers', () => {
  it('parseMonitorOpt accepts non-negative integers and rejects named values', () => {
    expect(String(machineInternals.parseMonitorOpt('all'))).toMatch(/^error:/);
    expect(String(machineInternals.parseMonitorOpt('primary'))).toMatch(/^error:/);
    expect(machineInternals.parseMonitorOpt('0')).toBe(0);
    expect(machineInternals.parseMonitorOpt('3')).toBe(3);
    expect(String(machineInternals.parseMonitorOpt('-1'))).toMatch(/^error:/);
    expect(String(machineInternals.parseMonitorOpt('1.5'))).toMatch(/^error:/);
    expect(String(machineInternals.parseMonitorOpt('hello'))).toMatch(/^error:/);
  });

  it('defaultScreenshotFilename strips path-illegal chars and ends with .png', () => {
    const f = machineInternals.defaultScreenshotFilename('weird:id*');
    expect(f.startsWith('screenshot-weird_id_-')).toBe(true);
    expect(f.endsWith('.png')).toBe(true);
  });
});
