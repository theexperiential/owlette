/**
 * HTTP-shape tests for `owlette process …`.
 *
 * Every verb of the wave-2B public scoped process api gets covered:
 *   GET    /api/sites/:siteId/machines/:machineId/processes
 *   POST   /api/sites/:siteId/machines/:machineId/processes
 *   GET    /api/sites/:siteId/machines/:machineId/processes/:processId
 *   PATCH  .../:processId
 *   DELETE .../:processId
 *   POST   .../:processId/{kill,restart,start,stop}
 *   POST   .../:processId/schedule
 *
 * Properties asserted (in addition to plain url + method shape):
 *   - mutations send `Idempotency-Key: cli-process-<verb>-<uuid>`
 *   - --json round-trips the server `data` field byte-identical
 *   - `duplicate_process_name` 409 surfaces the stable code + hint
 *   - `scope_insufficient` 403 surfaces the missing-scope hint
 *   - `process schedule` validates --mode + --blocks json + scheduled-mode
 *     requires non-empty blocks; the parsed blocks are forwarded as-is
 *   - `process delete` honors `--yes` (and refuses without it on non-tty)
 *   - schedule uses POST and idempotency-key (server writes through
 *     withProcessLock, no command queue)
 */

import { Command } from 'commander';
import { registerProcessCommands } from '../../src/commands/process';
import { _resetConfigCache } from '../../src/config';

function buildProgram(): Command {
  const program = new Command();
  program.name('owlette').exitOverride().option('--profile <name>').option('--json');
  registerProcessCommands(program);
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
  // Ensure `process delete` without --yes on a non-tty bails (we test
  // the --yes path explicitly; non-tty + no --yes is its own assertion).
});

afterEach(() => {
  delete process.env.OWLETTE_TOKEN;
  delete process.env.OWLETTE_API_URL;
  delete process.env.OWLETTE_PROFILE;
  jest.restoreAllMocks();
});

const URL_PREFIX = 'https://dev.test/api/sites/site-1/machines/m-1/processes';

/* -------------------------------------------------------------------- */
/*  list / get                                                           */
/* -------------------------------------------------------------------- */

describe('owlette process list', () => {
  it('GETs the processes list with Bearer auth', async () => {
    const calls = installFetchStub({ ok: true, data: { processes: [], nextPageToken: null } });
    const program = buildProgram();

    await program.parseAsync(
      ['--json', 'process', 'list', '--site', 'site-1', '--machine', 'm-1'],
      { from: 'user' },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(URL_PREFIX);
    expect((calls[0]!.init.method ?? 'GET').toUpperCase()).toBe('GET');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
  });

  it('emits the unwrapped data envelope in --json mode', async () => {
    const data = {
      processes: [
        {
          processId: 'proc_abc',
          name: 'td',
          launch_mode: 'always',
          status: 'running',
          pid: 1234,
        },
      ],
      nextPageToken: null,
    };
    installFetchStub({ ok: true, data });
    const writes: string[] = [];
    (process.stdout.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      writes.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(
      ['--json', 'process', 'list', '--site', 'site-1', '--machine', 'm-1'],
      { from: 'user' },
    );

    expect(JSON.parse(writes.join(''))).toEqual(data);
  });
});

describe('owlette process get', () => {
  it('GETs /processes/:processId and renders detail (human mode)', async () => {
    const calls = installFetchStub({
      ok: true,
      data: {
        processId: 'proc_abc',
        name: 'td',
        exe_path: 'C:/td.exe',
        cwd: 'C:/work',
        priority: 'Normal',
        visibility: 'Show',
        launch_mode: 'always',
        autolaunch: true,
        status: 'running',
        pid: 1234,
        responsive: true,
        schedule: null,
        schedules: null,
        last_updated: '2026-04-25T12:00:00Z',
      },
    });
    const program = buildProgram();

    await program.parseAsync(
      ['process', 'get', 'proc_abc', '--site', 'site-1', '--machine', 'm-1'],
      { from: 'user' },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${URL_PREFIX}/proc_abc`);
    expect((calls[0]!.init.method ?? 'GET').toUpperCase()).toBe('GET');
  });
});

/* -------------------------------------------------------------------- */
/*  create                                                               */
/* -------------------------------------------------------------------- */

describe('owlette process create', () => {
  it('POSTs body {name,exe_path,...} with idempotency key', async () => {
    const calls = installFetchStub({ ok: true, data: { processId: 'proc_new' } }, 201);
    const program = buildProgram();

    await program.parseAsync(
      [
        '--json',
        'process',
        'create',
        '--site',
        'site-1',
        '--machine',
        'm-1',
        '--name',
        'td',
        '--exe',
        'C:/td.exe',
        '--cwd',
        'C:/work',
        '--launch-mode',
        'always',
      ],
      { from: 'user' },
    );

    expect(calls[0]!.url).toBe(URL_PREFIX);
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^cli-process-create-/);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({
      name: 'td',
      exe_path: 'C:/td.exe',
      cwd: 'C:/work',
      launch_mode: 'always',
    });
  });

  it('surfaces the duplicate_process_name 409 with the canonical hint', async () => {
    installFetchStub(
      {
        type: 'about:blank',
        title: 'duplicate_process_name',
        status: 409,
        code: 'duplicate_process_name',
        detail: 'Process named `td` already exists on m-1',
      },
      409,
    );
    const stderr: string[] = [];
    (process.stderr.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      stderr.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(
      [
        'process',
        'create',
        '--site',
        'site-1',
        '--machine',
        'm-1',
        '--name',
        'td',
        '--exe',
        'C:/td.exe',
      ],
      { from: 'user' },
    );

    const errOut = stderr.join('');
    expect(errOut).toContain('code=duplicate_process_name');
    expect(errOut).toContain('process names must be unique per machine');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('rejects --launch-mode that is not in the allowlist before issuing http', async () => {
    const calls = installFetchStub({ ok: true, data: { processId: 'x' } });
    const program = buildProgram();

    await program.parseAsync(
      [
        'process',
        'create',
        '--site',
        'site-1',
        '--machine',
        'm-1',
        '--name',
        'td',
        '--exe',
        'C:/td.exe',
        '--launch-mode',
        'banana',
      ],
      { from: 'user' },
    );

    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

/* -------------------------------------------------------------------- */
/*  update                                                               */
/* -------------------------------------------------------------------- */

describe('owlette process update', () => {
  it('PATCHes only fields the user passed (live-update of name + visibility)', async () => {
    const calls = installFetchStub({ ok: true, data: { processId: 'proc_abc' } });
    const program = buildProgram();

    await program.parseAsync(
      [
        '--json',
        'process',
        'update',
        'proc_abc',
        '--site',
        'site-1',
        '--machine',
        'm-1',
        '--name',
        'td-renamed',
        '--visibility',
        'minimized',
      ],
      { from: 'user' },
    );

    expect(calls[0]!.url).toBe(`${URL_PREFIX}/proc_abc`);
    expect(calls[0]!.init.method).toBe('PATCH');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^cli-process-update-/);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({ name: 'td-renamed', visibility: 'minimized' });
  });

  it('refuses an empty patch (no fields → exit 1, no http)', async () => {
    const calls = installFetchStub({ ok: true, data: { processId: 'proc_abc' } });
    const program = buildProgram();

    await program.parseAsync(
      ['process', 'update', 'proc_abc', '--site', 'site-1', '--machine', 'm-1'],
      { from: 'user' },
    );

    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

/* -------------------------------------------------------------------- */
/*  delete                                                               */
/* -------------------------------------------------------------------- */

describe('owlette process delete', () => {
  it('DELETEs and prints the alreadyDeleted=true no-op message', async () => {
    const calls = installFetchStub({
      ok: true,
      data: { processId: 'proc_abc', alreadyDeleted: true },
    });
    const program = buildProgram();

    await program.parseAsync(
      [
        'process',
        'delete',
        'proc_abc',
        '--site',
        'site-1',
        '--machine',
        'm-1',
        '--yes',
      ],
      { from: 'user' },
    );

    expect(calls[0]!.url).toBe(`${URL_PREFIX}/proc_abc`);
    expect(calls[0]!.init.method).toBe('DELETE');
  });

  it('refuses to run without --yes when stdin is not a tty', async () => {
    const calls = installFetchStub({ ok: true, data: { processId: 'proc_abc', alreadyDeleted: false } });
    // jest's stdin is not a tty by default; assert isTTY is falsy and
    // the cli bails before issuing fetch.
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    const program = buildProgram();

    await program.parseAsync(
      ['process', 'delete', 'proc_abc', '--site', 'site-1', '--machine', 'm-1'],
      { from: 'user' },
    );

    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

/* -------------------------------------------------------------------- */
/*  kill / restart / start / stop                                        */
/* -------------------------------------------------------------------- */

describe.each([
  ['kill', 'kill_process'],
  ['restart', 'restart_process'],
  ['start', 'start_process'],
  ['stop', 'stop_process'],
] as const)('owlette process %s', (verb, _commandType) => {
  it(`POSTs /processes/:processId/${verb} with idempotency key`, async () => {
    const calls = installFetchStub(
      { ok: true, data: { commandId: 'cmd-123', status: 'pending' } },
      202,
    );
    const program = buildProgram();

    await program.parseAsync(
      ['--json', 'process', verb, 'proc_abc', '--site', 'site-1', '--machine', 'm-1'],
      { from: 'user' },
    );

    expect(calls[0]!.url).toBe(`${URL_PREFIX}/proc_abc/${verb}`);
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(new RegExp(`^cli-process-${verb}-`));
  });

  it(`auto-generates a unique idempotency key per ${verb} request (replay safety)`, async () => {
    const calls = installFetchStub(
      { ok: true, data: { commandId: 'cmd-123', status: 'pending' } },
      202,
    );
    const program1 = buildProgram();
    const program2 = buildProgram();

    await program1.parseAsync(
      ['--json', 'process', verb, 'proc_abc', '--site', 'site-1', '--machine', 'm-1'],
      { from: 'user' },
    );
    await program2.parseAsync(
      ['--json', 'process', verb, 'proc_abc', '--site', 'site-1', '--machine', 'm-1'],
      { from: 'user' },
    );

    const k1 = (calls[0]!.init.headers as Record<string, string>)['Idempotency-Key']!;
    const k2 = (calls[1]!.init.headers as Record<string, string>)['Idempotency-Key']!;
    expect(k1).not.toBe(k2);
    expect(k1).toMatch(new RegExp(`^cli-process-${verb}-`));
    expect(k2).toMatch(new RegExp(`^cli-process-${verb}-`));
  });
});

/* -------------------------------------------------------------------- */
/*  schedule                                                             */
/* -------------------------------------------------------------------- */

describe('owlette process schedule', () => {
  it('POSTs /schedule with mode + parsed blocks (mode=scheduled)', async () => {
    const calls = installFetchStub({
      ok: true,
      data: { processId: 'proc_abc', mode: 'scheduled' },
    });
    const program = buildProgram();
    const blocks = [
      { days: ['mon', 'tue'], ranges: [{ start: '09:00', stop: '17:00' }] },
    ];

    await program.parseAsync(
      [
        '--json',
        'process',
        'schedule',
        'proc_abc',
        '--site',
        'site-1',
        '--machine',
        'm-1',
        '--mode',
        'scheduled',
        '--blocks',
        JSON.stringify(blocks),
      ],
      { from: 'user' },
    );

    expect(calls[0]!.url).toBe(`${URL_PREFIX}/proc_abc/schedule`);
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^cli-process-schedule-/);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({ mode: 'scheduled', blocks });
  });

  it('lets mode=always omit --blocks (live-update with no schedule body)', async () => {
    const calls = installFetchStub({
      ok: true,
      data: { processId: 'proc_abc', mode: 'always' },
    });
    const program = buildProgram();

    await program.parseAsync(
      [
        '--json',
        'process',
        'schedule',
        'proc_abc',
        '--site',
        'site-1',
        '--machine',
        'm-1',
        '--mode',
        'always',
      ],
      { from: 'user' },
    );

    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({ mode: 'always' });
  });

  it('rejects mode=scheduled without --blocks before issuing http', async () => {
    const calls = installFetchStub({ ok: true, data: { processId: 'proc_abc', mode: 'scheduled' } });
    const program = buildProgram();

    await program.parseAsync(
      [
        'process',
        'schedule',
        'proc_abc',
        '--site',
        'site-1',
        '--machine',
        'm-1',
        '--mode',
        'scheduled',
      ],
      { from: 'user' },
    );

    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('rejects an invalid --mode value before issuing http', async () => {
    const calls = installFetchStub({ ok: true, data: {} });
    const program = buildProgram();

    await program.parseAsync(
      [
        'process',
        'schedule',
        'proc_abc',
        '--site',
        'site-1',
        '--machine',
        'm-1',
        '--mode',
        'banana',
      ],
      { from: 'user' },
    );

    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('rejects --blocks that is not valid json before issuing http', async () => {
    const calls = installFetchStub({ ok: true, data: {} });
    const program = buildProgram();

    await program.parseAsync(
      [
        'process',
        'schedule',
        'proc_abc',
        '--site',
        'site-1',
        '--machine',
        'm-1',
        '--mode',
        'scheduled',
        '--blocks',
        'not-json',
      ],
      { from: 'user' },
    );

    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

/* -------------------------------------------------------------------- */
/*  scope_insufficient                                                   */
/* -------------------------------------------------------------------- */

describe('scope_insufficient surfacing', () => {
  it('renders the missing-scope hint when the server returns 403/scope_insufficient', async () => {
    installFetchStub(
      {
        type: 'about:blank',
        title: 'scope_insufficient',
        status: 403,
        code: 'scope_insufficient',
        detail: 'API key is missing machine=m-1:write scope',
      },
      403,
    );
    const stderr: string[] = [];
    (process.stderr.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      stderr.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(
      ['process', 'kill', 'proc_abc', '--site', 'site-1', '--machine', 'm-1'],
      { from: 'user' },
    );

    const errOut = stderr.join('');
    expect(errOut).toContain('code=scope_insufficient');
    expect(errOut).toContain('your key is missing the required scope: machine=<id>:write');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});
