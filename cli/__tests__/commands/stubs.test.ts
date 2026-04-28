/**
 * Stub-command coverage tests.
 *
 * The only remaining public-api deferred stub the CLI ships is
 * `machine live-view`. That surface is intentionally outside the MVP
 * until the WebRTC-native implementation is prioritized.
 *
 * For that verb we assert the same three properties every other promoted
 * verb used to satisfy:
 *   1. invoking the verb terminates the process with exit code 3
 *   2. human-mode stderr surfaces the dashboard url + future-plan path
 *      + the verb name in the header line
 *   3. `--json` mode emits the canonical envelope on stdout:
 *        { ok: false, stub: true, noun, reason, dashboard_url, future_plan }
 *      (snake_case keys per docs/cli/overview.md#json-envelope-schema)
 *
 * Earlier batches' verbs (chat / user / deploy / installer / process /
 * the other 3 machine mutations) are now real http handlers — their
 * coverage moved to dedicated `*-http.test.ts` files.
 *
 * Because `stubExit` calls `process.exit(3)` synchronously, we mock
 * `process.exit` to throw a sentinel error so jest can observe the
 * intended exit code without the worker actually dying. Test bodies
 * catch the sentinel (parseAsync is async) and assert against captured
 * stdout / stderr.
 *
 * Drives:
 *   src/commands/machine.ts (live-view stub)
 *   src/lib/stubExit.ts (canonical envelope shape)
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

interface StubFixture {
  noun: string;
  verb: string;
  /** argv after the global flags + before any per-mode --json prefix. */
  argv: string[];
  dashboardPath: string;
  /** Substring that the future-plan field must contain. */
  futurePlanSubstr: string;
}

const FIXTURES: StubFixture[] = [
  {
    noun: 'machine',
    verb: 'live-view',
    argv: ['machine', 'live-view', 'm-1', '--site', 'site-1'],
    dashboardPath: '/dashboard',
    futurePlanSubstr: 'live-view-webrtc',
  },
];

const API_URL = 'https://dev.test';

class StubExitError extends Error {
  constructor(public code: number) {
    super(`__stub_exit_${code}__`);
  }
}

function installExitSpy(): jest.SpyInstance {
  return jest
    .spyOn(process, 'exit')
    .mockImplementation(((code?: number) => {
      throw new StubExitError(code ?? 0);
    }) as never);
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
  process.env.OWLETTE_API_URL = API_URL;
  process.env.OWLETTE_PROFILE = 'default';
});

afterEach(() => {
  delete process.env.OWLETTE_TOKEN;
  delete process.env.OWLETTE_API_URL;
  delete process.env.OWLETTE_PROFILE;
  jest.restoreAllMocks();
});

describe.each(FIXTURES)('owlette $noun $verb (stub)', (fix) => {
  it('exits 3 and surfaces the dashboard + future plan on stderr in human mode', async () => {
    const exitSpy = installExitSpy();
    const stderr: string[] = [];
    jest.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    });
    const program = buildProgram();

    let caught: unknown;
    try {
      await program.parseAsync(fix.argv, { from: 'user' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(StubExitError);
    expect((caught as StubExitError).code).toBe(3);
    expect(exitSpy).toHaveBeenCalledWith(3);

    const err = stderr.join('');
    expect(err).toContain(`\`${fix.noun} ${fix.verb}\``);
    expect(err).toContain(`${API_URL}${fix.dashboardPath}`);
    expect(err).toContain(fix.futurePlanSubstr);
    expect(err).toContain('is a stub');
  });

  it('emits the canonical {ok:false, stub:true, ...} envelope on stdout in --json mode', async () => {
    const exitSpy = installExitSpy();
    const stdout: string[] = [];
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    });
    const program = buildProgram();

    let caught: unknown;
    try {
      await program.parseAsync(['--json', ...fix.argv], { from: 'user' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(StubExitError);
    expect((caught as StubExitError).code).toBe(3);
    expect(exitSpy).toHaveBeenCalledWith(3);

    const parsed = JSON.parse(stdout.join('')) as Record<string, unknown>;
    expect(parsed.ok).toBe(false);
    expect(parsed.stub).toBe(true);
    expect(parsed.noun).toBe(fix.noun);
    expect(parsed.dashboard_url).toBe(`${API_URL}${fix.dashboardPath}`);
    expect(typeof parsed.future_plan).toBe('string');
    expect(parsed.future_plan as string).toContain(fix.futurePlanSubstr);
    expect(typeof parsed.reason).toBe('string');
    // Snake_case keys are load-bearing per command-surface.md — guard against
    // an accidental flip to camelCase in stubExit.ts.
    expect(parsed.dashboardUrl).toBeUndefined();
    expect(parsed.futurePlan).toBeUndefined();
  });
});

describe('stubExit envelope contract', () => {
  it('JSON envelope keys are exactly {ok, stub, noun, reason, dashboard_url, future_plan}', async () => {
    installExitSpy();
    const stdout: string[] = [];
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    });
    const program = buildProgram();

    try {
      await program.parseAsync(
        ['--json', 'machine', 'live-view', 'm-1', '--site', 'site-1'],
        { from: 'user' },
      );
    } catch {
      /* sentinel */
    }

    const parsed = JSON.parse(stdout.join('')) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      ['dashboard_url', 'future_plan', 'noun', 'ok', 'reason', 'stub'].sort(),
    );
  });
});
