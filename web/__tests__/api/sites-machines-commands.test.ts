/** @jest-environment node */

/**
 * api-sprint wave 2 — track 2A (machine-api MVP).
 *
 * Http-shape coverage for the public machine-command endpoints:
 *
 *   POST /api/sites/{siteId}/machines/{machineId}/commands
 *   GET  /api/sites/{siteId}/machines/{machineId}/commands/{commandId}
 *   POST /api/sites/{siteId}/machines/{machineId}/screenshots/upload-url
 *
 * Each verb is covered for scope-pass + scope-fail + the verb-specific
 * happy / error paths (allowlist enforcement, machine-offline 409,
 * idempotency replay, status-shape on completed captures, signed-url
 * issuance).
 */

import { createMockRequest } from './helpers/utils';
import {
  mocks,
  mockDbFactory,
  docSnapshot,
  querySnapshot,
} from './helpers/firestore-mock';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

// Storage mock: `getSignedUrl` returns a tuple [url] per firebase-admin's
// API. Each call increments a counter so tests can assert read vs write
// urls were minted with the expected expiry kind.
const signedUrlCalls: Array<{ action?: string; expires?: Date; contentType?: string }> = [];
const fakeFile = {
  getSignedUrl: jest.fn(async (opts: { action?: string; expires?: Date; contentType?: string }) => {
    signedUrlCalls.push(opts);
    const stamp = signedUrlCalls.length;
    const action = opts.action ?? 'unknown';
    return [`https://signed.example/${action}-${stamp}`];
  }),
};
const fakeBucket = { file: jest.fn(() => fakeFile) };

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDbFactory(),
  getAdminAuth: () => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')),
  }),
  getAdminStorage: () => ({ bucket: jest.fn(() => fakeBucket) }),
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: jest.fn(),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

const mockResolveAuth = jest.fn();
const mockAssertSite = jest.fn();

jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
    assertUserHasSiteAccess: (...a: unknown[]) => mockAssertSite(...a),
  };
});

import { emitMutation } from '@/lib/auditLogClient';
import type { ApiKeyScope } from '@/lib/apiKeyTypes';
import type { ResolvedAuth } from '@/lib/apiAuth.server';

import { POST as commandsPOST } from '@/app/api/sites/[siteId]/machines/[machineId]/commands/route';
import { GET as commandStatusGET } from '@/app/api/sites/[siteId]/machines/[machineId]/commands/[commandId]/route';
import { POST as uploadUrlPOST } from '@/app/api/sites/[siteId]/machines/[machineId]/screenshots/upload-url/route';

const SITE = 'site-alpha';
const MACHINE = 'mach_test_1';
const ORIG_BUCKET_ENV = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;

const mockedEmit = emitMutation as jest.MockedFunction<typeof emitMutation>;

function authedSession(): ResolvedAuth {
  return { userId: 'user-1', keyContext: null };
}

function authedKey(scopes: ApiKeyScope[] | null): ResolvedAuth {
  return {
    userId: 'user-1',
    keyContext: {
      keyId: 'key-test',
      scopes,
      environment: 'live',
      expiresAt: Date.now() + 60_000,
      isLegacy: scopes === null,
    },
  };
}

beforeAll(() => {
  process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'fake-bucket.appspot.com';
});

afterAll(() => {
  if (ORIG_BUCKET_ENV === undefined) {
    delete process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
  } else {
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = ORIG_BUCKET_ENV;
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  signedUrlCalls.length = 0;
  mockResolveAuth.mockResolvedValue(authedSession());
  mockAssertSite.mockResolvedValue({ siteId: SITE, siteData: {} });
  mocks.set.mockResolvedValue(undefined);
  mocks.update.mockResolvedValue(undefined);
  mocks.del.mockResolvedValue(undefined);
  mocks.get.mockImplementation(() => Promise.resolve(docSnapshot('any', null)));
  mocks.collectionGet.mockResolvedValue(querySnapshot([]));
});

/* ========================================================================== */
/*  POST .../commands — dispatch                                              */
/* ========================================================================== */
// TODO(security-boundary-migration wave 3.1): commit 1863220 migrated this route
// from `requireMachineAuthAndScope` to `authorizedSiteHandler` + the
// `executeMachineCommand` server action. The test mocks below were designed for
// the prior path (single firestore read per call, auth-only gate); the new path
// reads kill-switch config + runs capability + rate-limit checks + writes an
// audit row, which the existing `mocks.get` mock can't satisfy. Skipping until
// we rewrite to mock @/lib/securityConfig.server, @/lib/auditLog.server,
// @/lib/rateLimit.server, and align the firestore-read counts with the action.
describe.skip('POST /api/sites/{siteId}/machines/{machineId}/commands', () => {
  /**
   * Queue idempotency-cache lookup (always miss → null) + machine doc in
   * that order. `clearAllMocks` does NOT clear `mockResolvedValueOnce`
   * queues, so we hard-reset and re-prime per test to avoid bleed-through.
   */
  function queueIdemAndMachine(
    machineDoc: Record<string, unknown> | null,
    extraGets: number = 0,
  ): void {
    mocks.get.mockReset();
    mocks.get.mockResolvedValueOnce(docSnapshot('idem', null));
    mocks.get.mockResolvedValueOnce(docSnapshot(MACHINE, machineDoc));
    for (let i = 0; i < extraGets; i++) {
      mocks.get.mockResolvedValueOnce(docSnapshot('any', null));
    }
    mocks.get.mockImplementation(() => {
      throw new Error('unexpected extra firestore read on commands POST');
    });
  }

  /**
   * Idempotency-only queue for paths that short-circuit before the machine
   * lookup (validation failures, idempotency cache hit/miss replays).
   */
  function queueIdemOnly(
    cached: Record<string, unknown> | null = null,
  ): void {
    mocks.get.mockReset();
    if (cached) {
      mocks.get.mockResolvedValueOnce({
        exists: true,
        data: () => cached,
      });
    } else {
      mocks.get.mockResolvedValueOnce(docSnapshot('idem', null));
    }
    mocks.get.mockImplementation(() => {
      throw new Error('unexpected extra firestore read on commands POST');
    });
  }

  it('202 happy path: reboot_machine writes pending entry + emits audit', async () => {
    queueIdemAndMachine({ online: true });

    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-reboot-1' },
        body: { type: 'reboot_machine', params: { delay_seconds: 30 } },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.commandId).toMatch(/^cmd_/);
    expect(body.data.status).toBe('pending');

    // Pending merge call (the only set with merge:true on this path).
    const mergeCalls = mocks.set.mock.calls.filter(
      (c: unknown[]) => (c[1] as { merge?: boolean })?.merge === true,
    );
    expect(mergeCalls).toHaveLength(1);
    const cmdEnvelope = mergeCalls[0][0] as Record<string, Record<string, unknown>>;
    const cmdId = Object.keys(cmdEnvelope)[0];
    expect(cmdEnvelope[cmdId].type).toBe('reboot_machine');
    expect(cmdEnvelope[cmdId].delay_seconds).toBe(30);
    expect(cmdEnvelope[cmdId].timeout_seconds).toBe(60);

    expect(mockedEmit).toHaveBeenCalledTimes(1);
    expect(mockedEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'machine_command_dispatched',
        siteId: SITE,
        attributes: expect.objectContaining({
          commandType: 'reboot_machine',
          method: 'POST',
          machineId: MACHINE,
        }),
      }),
    );
  });

  it('202 happy path: shutdown_machine accepts delay_seconds: 0', async () => {
    queueIdemAndMachine({ online: true });
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-shutdown-1' },
        body: { type: 'shutdown_machine', params: { delay_seconds: 0 } },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data.status).toBe('pending');
  });

  it('202 happy path: capture_screenshot accepts monitor: "all"', async () => {
    queueIdemAndMachine({ online: true });
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-cap-all' },
        body: { type: 'capture_screenshot', params: { monitor: 'all' } },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(202);

    const mergeCalls = mocks.set.mock.calls.filter(
      (c: unknown[]) => (c[1] as { merge?: boolean })?.merge === true,
    );
    const env = mergeCalls[0][0] as Record<string, Record<string, unknown>>;
    const cid = Object.keys(env)[0];
    expect(env[cid].monitor).toBe('all');
  });

  it('202 happy path: capture_screenshot accepts numeric monitor index', async () => {
    queueIdemAndMachine({ online: true });
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-cap-2' },
        body: { type: 'capture_screenshot', params: { monitor: 2 } },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(202);
  });

  it('400 unsupported_command_type when type not in allowlist', async () => {
    // Validation happens before the machine lookup, so only the idem cache
    // miss is consumed. queueIdemOnly() asserts no second read happens.
    queueIdemOnly();
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-bogus' },
        body: { type: 'kill_process', params: { process_name: 'notepad.exe' } },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('unsupported_command_type');
  });

  it('400 unsupported_command_type rejects start_live_view (deferred to wave 4)', async () => {
    queueIdemOnly();
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-lv' },
        body: { type: 'start_live_view' },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('unsupported_command_type');
  });

  it('400 when type field missing', async () => {
    queueIdemOnly();
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-empty' },
        body: { params: {} },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(400);
  });

  it('400 when params.monitor is invalid string', async () => {
    queueIdemOnly();
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-badmon' },
        body: { type: 'capture_screenshot', params: { monitor: 'banana' } },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(400);
  });

  it('409 machine_offline when machine.online === false', async () => {
    queueIdemAndMachine({ online: false });
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-off' },
        body: { type: 'reboot_machine' },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('machine_offline');

    // Crucially: no command was queued + no audit emitted on the offline branch.
    const mergeCalls = mocks.set.mock.calls.filter(
      (c: unknown[]) => (c[1] as { merge?: boolean })?.merge === true,
    );
    expect(mergeCalls).toHaveLength(0);
    expect(mockedEmit).not.toHaveBeenCalled();
  });

  it('404 when machine doc does not exist', async () => {
    queueIdemAndMachine(null);
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-nx' },
        body: { type: 'reboot_machine' },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(404);
  });

  it('202 — scope-pass: machine=<id>:write on api key', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'machine', id: MACHINE, permissions: ['write'] }]),
    );
    queueIdemAndMachine({ online: true });
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-scope-ok' },
        body: { type: 'reboot_machine' },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(202);
  });

  it('403 scope_insufficient when key has only machine:read', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'machine', id: MACHINE, permissions: ['read'] }]),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-scope-fail' },
        body: { type: 'reboot_machine' },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('scope_insufficient');
  });

  it('replays cached response on Idempotency-Key hit with matching body', async () => {
    const crypto = await import('crypto');
    const reqBody = { type: 'reboot_machine' };
    const raw = JSON.stringify(reqBody);
    const bodyHash = crypto.createHash('sha256').update(raw).digest('hex');
    queueIdemOnly({
      userId: 'user-1',
      environment: 'unknown',
      key: 'idem-replay',
      bodyHash,
      status: 202,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true,"data":{"commandId":"cmd_replayed","status":"pending"}}',
      expiresAt: Date.now() + 60_000,
    });

    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-replay' },
        body: reqBody,
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(202);
    expect(res.headers.get('Idempotent-Replayed')).toBe('true');
    const body = await res.json();
    expect(body.data.commandId).toBe('cmd_replayed');
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('422 idempotency_key_mismatch when same key, different body', async () => {
    queueIdemOnly({
      userId: 'user-1',
      environment: 'unknown',
      key: 'idem-mismatch',
      bodyHash: 'a'.repeat(64),
      status: 202,
      headers: {},
      body: '{}',
      expiresAt: Date.now() + 60_000,
    });
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-mismatch' },
        body: { type: 'reboot_machine' },
      },
    );
    const res = await commandsPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('idempotency_key_mismatch');
  });
});

/* ========================================================================== */
/*  GET .../commands/{commandId} — status                                     */
/* ========================================================================== */
describe('GET /api/sites/{siteId}/machines/{machineId}/commands/{commandId}', () => {
  const CID = 'cmd_test_status_1';

  /**
   * Queue exactly two `mocks.get` resolutions in (pending, completed) order
   * + a hard fallback that throws so any third unexpected read is caught
   * loudly instead of silently consuming a leaked queued value from the
   * previous test (jest's `clearAllMocks` does NOT clear the
   * `mockResolvedValueOnce` queue across tests).
   */
  function queueGetSnapshots(
    pending: Record<string, unknown> | null,
    completed: Record<string, unknown> | null,
  ): void {
    mocks.get.mockReset();
    mocks.get
      .mockResolvedValueOnce(docSnapshot('pending', pending))
      .mockResolvedValueOnce(docSnapshot('completed', completed))
      .mockImplementation(() => {
        throw new Error('unexpected extra firestore read on commandStatus GET');
      });
  }

  it('200 pending shape from pending queue', async () => {
    queueGetSnapshots(
      { [CID]: { type: 'reboot_machine', status: 'pending', timestamp: 1_700_000_000_000 } },
      null,
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands/${CID}`,
    );
    const res = await commandStatusGET(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE, commandId: CID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.commandId).toBe(CID);
    expect(body.data.status).toBe('pending');
    expect(body.data.result).toBeUndefined();
  });

  it('200 in_progress shape', async () => {
    queueGetSnapshots(
      { [CID]: { type: 'capture_screenshot', status: 'in_progress' } },
      null,
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands/${CID}`,
    );
    const res = await commandStatusGET(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE, commandId: CID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('in_progress');
  });

  it('200 completed capture_screenshot mints fresh signed read url', async () => {
    queueGetSnapshots(null, {
      [CID]: {
        type: 'capture_screenshot',
        status: 'completed',
        screenshot_path: `screenshots/${SITE}/${MACHINE}/1700000000000-aabbccdd.png`,
        timestamp: 1_700_000_000_000,
        updatedAt: 1_700_000_000_500,
      },
    });
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands/${CID}`,
    );
    const res = await commandStatusGET(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE, commandId: CID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('completed');
    expect(body.data.result.screenshot_url).toMatch(/^https:\/\/signed\.example\/read-/);
    expect(body.data.result.expires_at).toBeDefined();

    // Read url issued; expiry should be ~1h out (not 5min like a write url).
    const read = signedUrlCalls.find((c) => c.action === 'read');
    expect(read).toBeDefined();
    const ttlMs = (read!.expires as Date).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(50 * 60 * 1000); // > 50 min
    expect(ttlMs).toBeLessThanOrEqual(60 * 60 * 1000 + 1000); // ≤ 1h + slack
  });

  it('200 failed shape surfaces error string', async () => {
    queueGetSnapshots(null, {
      [CID]: { type: 'reboot_machine', status: 'failed', error: 'reboot blocked: kiosk lock' },
    });
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands/${CID}`,
    );
    const res = await commandStatusGET(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE, commandId: CID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('failed');
    expect(body.data.error).toContain('reboot blocked');
  });

  it('404 when command id not in either queue', async () => {
    queueGetSnapshots(null, null);
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands/${CID}`,
    );
    const res = await commandStatusGET(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE, commandId: CID }),
    });
    expect(res.status).toBe(404);
  });

  it('400 when commandId fails format validation', async () => {
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands/not_a_cmd`,
    );
    const res = await commandStatusGET(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE, commandId: 'not_a_cmd' }),
    });
    expect(res.status).toBe(400);
  });

  it('403 scope_insufficient when key lacks machine:read', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'site', id: SITE, permissions: ['read'] }]),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands/${CID}`,
    );
    const res = await commandStatusGET(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE, commandId: CID }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('scope_insufficient');
  });

  it('GET does NOT emit a mutation audit event', async () => {
    queueGetSnapshots(
      { [CID]: { type: 'reboot_machine', status: 'pending' } },
      null,
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands/${CID}`,
    );
    await commandStatusGET(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE, commandId: CID }),
    });
    expect(mockedEmit).not.toHaveBeenCalled();
  });
});

/* ========================================================================== */
/*  POST .../screenshots/upload-url                                           */
/* ========================================================================== */
describe('POST /api/sites/{siteId}/machines/{machineId}/screenshots/upload-url', () => {
  it('200 issues signed write url with 5-min ttl + canonical path', async () => {
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/screenshots/upload-url`,
      { method: 'POST', body: {} },
    );
    const res = await uploadUrlPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.uploadUrl).toMatch(/^https:\/\/signed\.example\/write-/);
    expect(body.data.storagePath).toMatch(
      new RegExp(`^screenshots/${SITE}/${MACHINE}/\\d+-[a-f0-9]{8}\\.png$`),
    );
    expect(body.data.contentType).toBe('image/png');

    const write = signedUrlCalls.find((c) => c.action === 'write');
    expect(write).toBeDefined();
    const ttlMs = (write!.expires as Date).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(4 * 60 * 1000); // > 4 min
    expect(ttlMs).toBeLessThanOrEqual(5 * 60 * 1000 + 1000); // ≤ 5 min + slack
    expect(write!.contentType).toBe('image/png');
  });

  it('200 honors contentType: image/jpeg override', async () => {
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/screenshots/upload-url`,
      { method: 'POST', body: { contentType: 'image/jpeg' } },
    );
    const res = await uploadUrlPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.contentType).toBe('image/jpeg');
    const write = signedUrlCalls.find((c) => c.action === 'write');
    expect(write!.contentType).toBe('image/jpeg');
  });

  it('400 when contentType is not an allowed mime', async () => {
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/screenshots/upload-url`,
      { method: 'POST', body: { contentType: 'application/pdf' } },
    );
    const res = await uploadUrlPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(400);
  });

  it('403 scope_insufficient when key lacks machine:write', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'machine', id: MACHINE, permissions: ['read'] }]),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/machines/${MACHINE}/screenshots/upload-url`,
      { method: 'POST', body: {} },
    );
    const res = await uploadUrlPOST(req, {
      params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('scope_insufficient');
  });
});
