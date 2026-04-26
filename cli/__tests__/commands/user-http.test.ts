/**
 * HTTP-shape tests for `owlette user list | get | promote | demote |
 * assign-sites | remove-sites | delete`.
 *
 * Intercepts global.fetch, builds an in-process commander program, and
 * asserts the request URL/method/headers/body match the contract documented
 * in `src/commands/user.ts` + the wave-3B route handlers.
 *
 * Special-cases the two server-side conflicts that get bespoke CLI handling:
 *   - 409 last_superadmin (demote)
 *   - 409 orphan_sites    (delete)
 */

import { Command } from 'commander';
import { registerUserCommands } from '../../src/commands/user';
import { _resetConfigCache } from '../../src/config';

function buildProgram(): Command {
  const program = new Command();
  program.name('owlette').exitOverride().option('--profile <name>').option('--json');
  registerUserCommands(program);
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

/* -------------------- list -------------------- */

describe('owlette user list', () => {
  it('GETs /api/users with Bearer auth (no query when no filters)', async () => {
    const calls = installFetchStub({ users: [], nextPageToken: '' });
    const program = buildProgram();
    await program.parseAsync(['--json', 'user', 'list'], { from: 'user' });
    expect(calls[0]!.url).toBe('https://dev.test/api/users');
    expect((calls[0]!.init.method ?? 'GET').toUpperCase()).toBe('GET');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
  });

  it('forwards --role / --site / --include-deleted / --limit / --cursor query params', async () => {
    const calls = installFetchStub({ users: [], nextPageToken: '' });
    const program = buildProgram();
    await program.parseAsync(
      [
        '--json',
        'user',
        'list',
        '--role',
        'admin',
        '--site',
        'site-1',
        '--include-deleted',
        '--limit',
        '10',
        '--cursor',
        'tok-3',
      ],
      { from: 'user' },
    );
    const url = calls[0]!.url;
    expect(url).toContain('role=admin');
    expect(url).toContain('site=site-1');
    expect(url).toContain('includeDeleted=true');
    expect(url).toContain('page_size=10');
    expect(url).toContain('page_token=tok-3');
  });

  it('emits the {users, nextPageToken} envelope in --json mode', async () => {
    const users = [
      {
        uid: 'u_1',
        email: 'a@b.co',
        role: 'admin',
        sites: ['s1'],
        displayName: null,
        firstName: null,
        lastName: null,
        createdAt: '2026-04-01T00:00:00Z',
        deletedAt: null,
      },
    ];
    installFetchStub({ users, nextPageToken: 'tok-next' });
    const writes: string[] = [];
    (process.stdout.write as unknown as jest.Mock).mockImplementation(
      (chunk: string) => {
        writes.push(chunk);
        return true;
      },
    );
    const program = buildProgram();
    await program.parseAsync(['--json', 'user', 'list'], { from: 'user' });
    const parsed = JSON.parse(writes.join('')) as {
      users: typeof users;
      nextPageToken: string;
    };
    expect(parsed.users).toEqual(users);
    expect(parsed.nextPageToken).toBe('tok-next');
  });
});

/* -------------------- get -------------------- */

describe('owlette user get', () => {
  it('GETs /api/users/:uid with Bearer auth', async () => {
    const calls = installFetchStub({
      uid: 'u_1',
      email: 'a@b.co',
      role: 'admin',
      sites: [],
      displayName: null,
      firstName: null,
      lastName: null,
      createdAt: null,
      deletedAt: null,
    });
    const program = buildProgram();
    await program.parseAsync(['--json', 'user', 'get', 'u_1'], { from: 'user' });
    expect(calls[0]!.url).toBe('https://dev.test/api/users/u_1');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
  });

  it('round-trips the raw detail in --json mode', async () => {
    const detail = {
      uid: 'u_2',
      email: 'c@d.co',
      role: 'superadmin',
      sites: ['s1', 's2'],
      displayName: 'Carla',
      firstName: 'Carla',
      lastName: 'Doe',
      createdAt: '2026-01-01T00:00:00Z',
      deletedAt: null,
    };
    installFetchStub(detail);
    const writes: string[] = [];
    (process.stdout.write as unknown as jest.Mock).mockImplementation(
      (chunk: string) => {
        writes.push(chunk);
        return true;
      },
    );
    const program = buildProgram();
    await program.parseAsync(['--json', 'user', 'get', 'u_2'], { from: 'user' });
    expect(JSON.parse(writes.join(''))).toEqual(detail);
  });
});

/* -------------------- promote -------------------- */

describe('owlette user promote', () => {
  it('POSTs /api/users/:uid/promote with role body + auto Idempotency-Key', async () => {
    const calls = installFetchStub({
      uid: 'u_1',
      role: 'admin',
      previousRole: 'member',
      changed: true,
    });
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'user', 'promote', 'u_1', '--role', 'admin'],
      { from: 'user' },
    );
    expect(calls[0]!.url).toBe('https://dev.test/api/users/u_1/promote');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Idempotency-Key']).toMatch(/^cli-user-promote-/);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ role: 'admin' });
  });

  it('rejects --role values outside admin|superadmin without firing fetch', async () => {
    const calls = installFetchStub({});
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'user', 'promote', 'u_1', '--role', 'member'],
      { from: 'user' },
    );
    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

/* -------------------- demote -------------------- */

describe('owlette user demote', () => {
  it('POSTs /api/users/:uid/demote with empty body + auto Idempotency-Key', async () => {
    const calls = installFetchStub({
      uid: 'u_1',
      role: 'member',
      previousRole: 'admin',
      changed: true,
    });
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'user', 'demote', 'u_1'],
      { from: 'user' },
    );
    expect(calls[0]!.url).toBe('https://dev.test/api/users/u_1/demote');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^cli-user-demote-/);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({});
  });

  it('surfaces 409 last_superadmin clearly on stderr', async () => {
    installFetchStub(
      {
        type: 'about:blank',
        title: 'cannot demote last superadmin',
        status: 409,
        detail: 'cannot demote: only 1 active superadmin(s) remain; floor is 1',
        code: 'last_superadmin',
        minSuperadmins: 1,
        currentActiveCount: 1,
      },
      409,
    );
    const stderr: string[] = [];
    (process.stderr.write as unknown as jest.Mock).mockImplementation(
      (chunk: string) => {
        stderr.push(chunk);
        return true;
      },
    );
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'user', 'demote', 'u_1'],
      { from: 'user' },
    );
    const err = stderr.join('');
    expect(err).toContain('last_superadmin');
    expect(err).toContain('promote another user first');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

/* -------------------- assign-sites -------------------- */

describe('owlette user assign-sites', () => {
  it('POSTs /api/users/:uid/assign-sites with siteIds[] body + auto Idempotency-Key', async () => {
    const calls = installFetchStub({
      uid: 'u_1',
      assignedSiteIds: ['s1', 's2'],
    });
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'user', 'assign-sites', 'u_1', '--sites', 's1,s2'],
      { from: 'user' },
    );
    expect(calls[0]!.url).toBe('https://dev.test/api/users/u_1/assign-sites');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^cli-user-assign-sites-/);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ siteIds: ['s1', 's2'] });
  });

  it('trims whitespace and drops empty entries from --sites csv', async () => {
    const calls = installFetchStub({ uid: 'u_1', assignedSiteIds: ['s1', 's2'] });
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'user', 'assign-sites', 'u_1', '--sites', ' s1 , ,s2'],
      { from: 'user' },
    );
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      siteIds: ['s1', 's2'],
    });
  });

  it('surfaces 400 unknown_site clearly with the offending sites listed', async () => {
    installFetchStub(
      {
        type: 'about:blank',
        title: 'unknown site(s)',
        status: 400,
        detail: 'one or more siteIds do not match an existing site',
        code: 'unknown_site',
        unknownSites: ['s_bad'],
      },
      400,
    );
    const stderr: string[] = [];
    (process.stderr.write as unknown as jest.Mock).mockImplementation(
      (chunk: string) => {
        stderr.push(chunk);
        return true;
      },
    );
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'user', 'assign-sites', 'u_1', '--sites', 's_bad'],
      { from: 'user' },
    );
    const err = stderr.join('');
    expect(err).toContain('unknown_site');
    expect(err).toContain('s_bad');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

/* -------------------- remove-sites -------------------- */

describe('owlette user remove-sites', () => {
  it('POSTs /api/users/:uid/remove-sites with siteIds[] body + auto Idempotency-Key', async () => {
    const calls = installFetchStub({
      uid: 'u_1',
      removedSiteIds: ['s1'],
      cancelledCommandCount: 2,
    });
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'user', 'remove-sites', 'u_1', '--sites', 's1'],
      { from: 'user' },
    );
    expect(calls[0]!.url).toBe('https://dev.test/api/users/u_1/remove-sites');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^cli-user-remove-sites-/);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ siteIds: ['s1'] });
  });

  it('rejects empty --sites without firing fetch', async () => {
    const calls = installFetchStub({});
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'user', 'remove-sites', 'u_1', '--sites', '   '],
      { from: 'user' },
    );
    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

/* -------------------- delete -------------------- */

describe('owlette user delete', () => {
  it('DELETEs /api/users/:uid with Bearer + auto Idempotency-Key when --yes is supplied', async () => {
    const calls = installFetchStub({
      uid: 'u_1',
      alreadyDeleted: false,
      deletedAt: 1700000000000,
      transferredSites: [],
      revokedKeyIds: [],
    });
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'user', 'delete', 'u_1', '--yes'],
      { from: 'user' },
    );
    expect(calls[0]!.url).toBe('https://dev.test/api/users/u_1');
    expect(calls[0]!.init.method).toBe('DELETE');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
    expect(headers['Idempotency-Key']).toMatch(/^cli-user-delete-/);
  });

  it('appends ?successorUid when --successor is supplied', async () => {
    const calls = installFetchStub({
      uid: 'u_1',
      alreadyDeleted: false,
      deletedAt: 1700000000000,
      transferredSites: ['s1'],
      revokedKeyIds: [],
    });
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'user', 'delete', 'u_1', '--yes', '--successor', 'u_2'],
      { from: 'user' },
    );
    expect(calls[0]!.url).toBe('https://dev.test/api/users/u_1?successorUid=u_2');
  });

  it('surfaces 409 orphan_sites clearly with the owned sites listed', async () => {
    installFetchStub(
      {
        type: 'about:blank',
        title: 'cannot delete: user owns sites',
        status: 409,
        detail:
          'user owns one or more sites; pass ?successorUid=<uid> to transfer ownership before deletion',
        code: 'orphan_sites',
        ownedSites: ['s1', 's2'],
      },
      409,
    );
    const stderr: string[] = [];
    (process.stderr.write as unknown as jest.Mock).mockImplementation(
      (chunk: string) => {
        stderr.push(chunk);
        return true;
      },
    );
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'user', 'delete', 'u_1', '--yes'],
      { from: 'user' },
    );
    const err = stderr.join('');
    expect(err).toContain('orphan_sites');
    expect(err).toContain('s1');
    expect(err).toContain('s2');
    expect(err).toContain('--successor');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});
