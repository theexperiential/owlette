/**
 * HTTP-shape tests for `owlette installer {list,upload,set-latest,delete}`.
 *
 * Drives src/commands/installer.ts. Stubs `global.fetch` per test (the
 * upload verb makes 3 separate calls — POST /api/installer/upload → PUT
 * <signedUrl> → PUT /api/installer/upload (finalize) — and we mock all
 * three in sequence). Asserts urls + methods + headers + body shape +
 * response parsing.
 *
 * api-sprint wave 5 — track 5.1 batch B.
 */

import { Command } from 'commander';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { registerInstallerCommands } from '../../src/commands/installer';
import { _resetConfigCache } from '../../src/config';

function buildProgram(): Command {
  const program = new Command();
  program.name('owlette').exitOverride().option('--profile <name>').option('--json');
  registerInstallerCommands(program);
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

/** Multi-step fetch stub: each call pulls the next response off the queue. */
function installFetchSequence(
  responses: Array<{ payload: unknown; status?: number }>,
): FetchCall[] {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(
    async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const next = queue.shift();
      if (!next) throw new Error(`fetch sequence exhausted at call ${calls.length}`);
      const status = next.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => next.payload,
        text: async () => JSON.stringify(next.payload),
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

/* --------------------------------------------------------------------- */
/*  list                                                                 */
/* --------------------------------------------------------------------- */

describe('owlette installer list', () => {
  it('GETs /api/installer with Bearer auth + no query when no flags given', async () => {
    const calls = installFetchStub({ versions: [], nextPageToken: '' });
    const program = buildProgram();
    await program.parseAsync(['--json', 'installer', 'list'], { from: 'user' });
    expect(calls[0]!.url).toBe('https://dev.test/api/installer');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
    expect(headers['Idempotency-Key']).toBeUndefined();
  });

  it('passes --include-deleted, --limit and --cursor through to the query', async () => {
    const calls = installFetchStub({ versions: [], nextPageToken: '' });
    const program = buildProgram();
    await program.parseAsync(
      [
        '--json',
        'installer',
        'list',
        '--include-deleted',
        '--limit',
        '50',
        '--cursor',
        '2.10.0',
      ],
      { from: 'user' },
    );
    expect(calls[0]!.url).toBe(
      'https://dev.test/api/installer?includeDeleted=true&page_size=50&page_token=2.10.0',
    );
  });

  it('surfaces 403 scope_insufficient with the superadmin hint', async () => {
    const stderr: string[] = [];
    (process.stderr.write as unknown as jest.Mock).mockImplementation((c: string | Uint8Array) => {
      stderr.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf-8'));
      return true;
    });
    installFetchStub({ code: 'scope_insufficient', detail: 'requires installer:read' }, 403);
    const program = buildProgram();
    await program.parseAsync(['installer', 'list'], { from: 'user' });
    const out = stderr.join('');
    expect(out).toContain('scope_insufficient');
    expect(out).toContain('superadmin');
    expect(out).toContain('hint:');
    expect(process.exitCode).toBe(1);
  });
});

/* --------------------------------------------------------------------- */
/*  upload (3-step)                                                      */
/* --------------------------------------------------------------------- */

describe('owlette installer upload', () => {
  // Write a real fixture file to a tempdir so the source's `readFileSync`
  // + `statSync` paths work without mocking. The src file imports those
  // by name from 'fs', which jest's module mocker can't rewrite at the
  // namespace level — a tempdir fixture is simpler and exercises the
  // sha256 / size paths for real.
  const FAKE_BYTES = Buffer.from('the quick brown fox\n');
  let tempDir: string;
  let FAKE_FILE: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'owlette-cli-installer-test-'));
    FAKE_FILE = join(tempDir, 'Owlette-Installer-v2.11.0.exe');
    writeFileSync(FAKE_FILE, FAKE_BYTES);
  });
  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('runs the 3-step flow: POST → PUT signed url → PUT finalize, with same Idempotency-Key on POST + finalize', async () => {
    const calls = installFetchSequence([
      {
        payload: {
          uploadUrl: 'https://signed.example/upload?token=xyz',
          uploadId: 'upload-1',
          storagePath: 'agent-installers/versions/2.11.0/Owlette-Installer-v2.11.0.exe',
          expiresAt: '2026-01-01T00:15:00Z',
        },
      },
      { payload: '' }, // signed-url PUT — body irrelevant
      {
        payload: {
          version: '2.11.0',
          download_url: 'https://cdn.example/Owlette-Installer-v2.11.0.exe',
          checksum_sha256: 'a'.repeat(64),
          file_size: FAKE_BYTES.length,
        },
      },
    ]);
    const program = buildProgram();
    await program.parseAsync(
      [
        '--json',
        'installer',
        'upload',
        FAKE_FILE,
        '--version',
        '2.11.0',
        '--release-notes',
        'patch release',
        '--set-latest',
      ],
      { from: 'user' },
    );

    expect(calls).toHaveLength(3);

    // Step 1: POST /api/installer/upload
    expect(calls[0]!.url).toBe('https://dev.test/api/installer/upload');
    expect(calls[0]!.init.method).toBe('POST');
    const startHeaders = calls[0]!.init.headers as Record<string, string>;
    expect(startHeaders.Authorization).toBe('Bearer owk_live_testtoken');
    expect(startHeaders['Idempotency-Key']).toMatch(/^cli-installer-upload-/);
    const startBody = JSON.parse(String(calls[0]!.init.body));
    expect(startBody.version).toBe('2.11.0');
    expect(startBody.fileName).toBe('Owlette-Installer-v2.11.0.exe');
    expect(startBody.releaseNotes).toBe('patch release');
    expect(startBody.setAsLatest).toBe(true);

    // Step 2: PUT to the signed url
    expect(calls[1]!.url).toBe('https://signed.example/upload?token=xyz');
    expect(calls[1]!.init.method).toBe('PUT');
    const putHeaders = calls[1]!.init.headers as Record<string, string>;
    expect(putHeaders['Content-Type']).toBe('application/octet-stream');
    expect(putHeaders['Content-Length']).toBe(String(FAKE_BYTES.length));

    // Step 3: PUT /api/installer/upload (finalize)
    expect(calls[2]!.url).toBe('https://dev.test/api/installer/upload');
    expect(calls[2]!.init.method).toBe('PUT');
    const finalizeHeaders = calls[2]!.init.headers as Record<string, string>;
    expect(finalizeHeaders['Idempotency-Key']).toBe(startHeaders['Idempotency-Key']);
    const finalizeBody = JSON.parse(String(calls[2]!.init.body));
    expect(finalizeBody.uploadId).toBe('upload-1');
    expect(finalizeBody.checksum_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses caller-supplied --idempotency-key on both POST and PUT-finalize', async () => {
    const calls = installFetchSequence([
      { payload: { uploadUrl: 'https://signed/u', uploadId: 'u-1' } },
      { payload: '' },
      { payload: { version: '2.11.0', download_url: 'd', checksum_sha256: 'a'.repeat(64), file_size: 1 } },
    ]);
    const program = buildProgram();
    await program.parseAsync(
      [
        '--json',
        'installer',
        'upload',
        FAKE_FILE,
        '--version',
        '2.11.0',
        '--idempotency-key',
        'pinned-key',
      ],
      { from: 'user' },
    );
    const startHeaders = calls[0]!.init.headers as Record<string, string>;
    const finalizeHeaders = calls[2]!.init.headers as Record<string, string>;
    expect(startHeaders['Idempotency-Key']).toBe('pinned-key');
    expect(finalizeHeaders['Idempotency-Key']).toBe('pinned-key');
  });

  it('aborts before the signed-url PUT if step 1 fails', async () => {
    const stderr: string[] = [];
    (process.stderr.write as unknown as jest.Mock).mockImplementation((c: string | Uint8Array) => {
      stderr.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf-8'));
      return true;
    });
    const calls = installFetchSequence([
      { payload: { code: 'scope_insufficient', detail: 'requires installer:write' }, status: 403 },
    ]);
    const program = buildProgram();
    await program.parseAsync(
      ['installer', 'upload', FAKE_FILE, '--version', '2.11.0'],
      { from: 'user' },
    );
    expect(calls).toHaveLength(1);
    const out = stderr.join('');
    expect(out).toContain('scope_insufficient');
    expect(out).toContain('superadmin');
    expect(process.exitCode).toBe(1);
  });
});

/* --------------------------------------------------------------------- */
/*  set-latest                                                           */
/* --------------------------------------------------------------------- */

describe('owlette installer set-latest', () => {
  it('POSTs /api/installer/:version/set-latest when --yes is supplied', async () => {
    const calls = installFetchStub({ version: '2.11.0', latest: { version: '2.11.0' } });
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'installer', 'set-latest', '2.11.0', '--yes'],
      { from: 'user' },
    );
    expect(calls[0]!.url).toBe('https://dev.test/api/installer/2.11.0/set-latest');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
    expect(headers['Idempotency-Key']).toMatch(/^cli-installer-set-latest-/);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({});
  });

  it('refuses to run silently without --yes when stdin is not a tty', async () => {
    const calls = installFetchStub({}, 200);
    const isTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    try {
      const program = buildProgram();
      await program.parseAsync(['installer', 'set-latest', '2.11.0'], { from: 'user' });
      expect(calls).toHaveLength(0);
      expect(process.exitCode).toBe(1);
    } finally {
      if (isTTY) Object.defineProperty(process.stdin, 'isTTY', isTTY);
    }
  });
});

/* --------------------------------------------------------------------- */
/*  delete                                                               */
/* --------------------------------------------------------------------- */

describe('owlette installer delete', () => {
  it('DELETEs /api/installer/:version when --yes is supplied', async () => {
    const calls = installFetchStub({
      version: '2.10.0',
      deletedAt: 1735689600000,
      alreadyDeleted: false,
    });
    const program = buildProgram();
    await program.parseAsync(
      ['--json', 'installer', 'delete', '2.10.0', '--yes'],
      { from: 'user' },
    );
    expect(calls[0]!.url).toBe('https://dev.test/api/installer/2.10.0');
    expect(calls[0]!.init.method).toBe('DELETE');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer owk_live_testtoken');
    expect(headers['Idempotency-Key']).toMatch(/^cli-installer-delete-/);
  });

  it('surfaces 409 min_versions_violated with the floor + active count', async () => {
    const stderr: string[] = [];
    (process.stderr.write as unknown as jest.Mock).mockImplementation((c: string | Uint8Array) => {
      stderr.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf-8'));
      return true;
    });
    installFetchStub(
      {
        code: 'min_versions_violated',
        detail: 'cannot delete: only 1 active version remains',
        minActiveVersions: 2,
        currentActiveCount: 1,
      },
      409,
    );
    const program = buildProgram();
    await program.parseAsync(['installer', 'delete', '2.10.0', '--yes'], { from: 'user' });
    const out = stderr.join('');
    expect(out).toContain('min_versions_violated');
    expect(out).toContain('at least 2');
    expect(out).toContain('hint:');
    expect(process.exitCode).toBe(1);
  });

  it('renders alreadyDeleted as a no-change message in human mode', async () => {
    const stdout: string[] = [];
    (process.stdout.write as unknown as jest.Mock).mockImplementation((c: string | Uint8Array) => {
      stdout.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf-8'));
      return true;
    });
    installFetchStub({ version: '2.10.0', deletedAt: 123, alreadyDeleted: true });
    const program = buildProgram();
    await program.parseAsync(['installer', 'delete', '2.10.0', '--yes'], { from: 'user' });
    const out = stdout.join('');
    expect(out).toContain('already deleted');
    expect(process.exitCode).toBe(0);
  });
});
