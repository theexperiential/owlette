import { Command } from 'commander';
import { registerRollbackCommand } from '../../src/commands/rollback';
import { _resetConfigCache } from '../../src/config';

function buildProgram(): Command {
  const program = new Command();
  program.name('owlette').exitOverride().option('--profile <name>').option('--json');
  registerRollbackCommand(program);
  return program;
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
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
  process.exitCode = 0;
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

describe('owlette rollback', () => {
  it('surfaces resolved --to and idempotency key on unconfirmed rollback failure', async () => {
    const calls: FetchCall[] = [];
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(
      async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        if (calls.length === 1) {
          return jsonResponse({
            roostId: 'rst_1',
            siteId: 'site-1',
            name: 'demo',
            currentVersionId: 'vrs_current',
            previousVersionId: 'vrs_previous',
            deletedAt: null,
          });
        }
        if (calls.length === 2) {
          return jsonResponse({
            versionId: 'vrs_resolved_previous',
            toVersion: 'vrs_resolved_previous',
            fromVersion: 'vrs_current',
            against: 'vrs_current',
            roostId: 'rst_1',
            siteId: 'site-1',
            summary: {
              added: 0,
              removed: 0,
              changed: 1,
              unchanged: 0,
              hasChanges: true,
              netBytesDelta: 0,
            },
            added: [],
            removed: [],
            modified: [],
          });
        }
        throw new Error('socket hang up');
      },
    );
    const stderr: string[] = [];
    (process.stderr.write as unknown as jest.Mock).mockImplementation((chunk: string) => {
      stderr.push(chunk);
      return true;
    });
    const program = buildProgram();

    await program.parseAsync(
      [
        'rollback',
        'rst_1',
        '--site',
        'site-1',
        '--to',
        'previous',
        '--yes',
        '--idempotency-key',
        'retry-key',
      ],
      { from: 'user' },
    );

    expect(calls).toHaveLength(3);
    expect(calls[1]!.url).toContain('/api/roosts/rst_1/versions/previous/diff');
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({
      siteId: 'site-1',
      targetVersion: 'vrs_resolved_previous',
    });
    const errOut = stderr.join('');
    expect(errOut).toContain('did not return a confirmed response');
    expect(errOut).toContain('Idempotency-Key: retry-key');
    expect(errOut).toContain('`--to vrs_resolved_previous --idempotency-key retry-key`');
    expect(process.exitCode).toBe(1);
  });
});
