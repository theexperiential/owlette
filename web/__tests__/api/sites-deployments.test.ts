/** @jest-environment node */

/**
 * api-sprint wave 1 — track 1A (installer-deploys-api).
 *
 * Http-shape coverage for the public site-scoped deployment endpoints:
 *
 *   GET    /api/sites/{siteId}/deployments
 *   POST   /api/sites/{siteId}/deployments
 *   GET    /api/sites/{siteId}/deployments/{deploymentId}
 *   POST   /api/sites/{siteId}/deployments/{deploymentId}/retry
 *   POST   /api/sites/{siteId}/deployments/{deploymentId}/cancel
 *   POST   /api/sites/{siteId}/deployments/{deploymentId}/uninstall
 *
 * Each verb is covered for scope-pass + scope-fail + the verb-specific
 * happy / error paths (validation, 413 over_quota, idempotency replay).
 * The admin /api/admin/deployments suite stays as-is and continues to
 * cover the dashboard-facing surface.
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

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDbFactory(),
  getAdminAuth: () => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')),
  }),
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

import { GET as listGET, POST as createPOST } from '@/app/api/sites/[siteId]/deployments/route';
import { GET as detailGET } from '@/app/api/sites/[siteId]/deployments/[deploymentId]/route';
import { POST as retryPOST } from '@/app/api/sites/[siteId]/deployments/[deploymentId]/retry/route';
import { POST as cancelPOST } from '@/app/api/sites/[siteId]/deployments/[deploymentId]/cancel/route';
import { POST as uninstallPOST } from '@/app/api/sites/[siteId]/deployments/[deploymentId]/uninstall/route';

const SITE = 'site-alpha';
const DEPLOYMENT = 'deploy-1700000000000';

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

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveAuth.mockResolvedValue(authedSession());
  mockAssertSite.mockResolvedValue({ siteId: SITE, siteData: {} });
  mocks.set.mockResolvedValue(undefined);
  mocks.update.mockResolvedValue(undefined);
  mocks.del.mockResolvedValue(undefined);
  mocks.get.mockImplementation(() => Promise.resolve(docSnapshot('any', null)));
  mocks.collectionGet.mockResolvedValue(querySnapshot([]));
});

const validCreateBody = {
  name: 'q2 vlc rollout',
  installer_name: 'vlc-3.0.21-win64.exe',
  installer_url: 'https://get.videolan.org/vlc/3.0.21/win64/vlc-3.0.21-win64.exe',
  silent_flags: '/S',
  machines: ['machine-1', 'machine-2'],
};

/* ========================================================================== */
/*  GET /api/sites/{siteId}/deployments — list                                */
/* ========================================================================== */
describe('GET /api/sites/{siteId}/deployments', () => {
  it('200 with cursor-paginated list', async () => {
    mocks.collectionGet.mockResolvedValueOnce(
      querySnapshot([
        {
          id: DEPLOYMENT,
          data: {
            name: 'rollout',
            installer_name: 'vlc.exe',
            installer_url: 'https://example.com/vlc.exe',
            silent_flags: '/S',
            targets: [{ machineId: 'm1', status: 'completed' }],
            status: 'completed',
            createdAt: 1_700_000_000_000,
          },
        },
      ]),
    );
    const req = createMockRequest(`http://localhost/api/sites/${SITE}/deployments`);
    const res = await listGET(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(DEPLOYMENT);
    expect(body.next_page_token).toBe('');
  });

  it('200 + emits next_page_token when over a page', async () => {
    // Return pageSize+1 docs so the route emits a non-empty next_page_token.
    mocks.collectionGet.mockResolvedValueOnce(
      querySnapshot(
        Array.from({ length: 26 }, (_, i) => ({
          id: `deploy-${i}`,
          data: { name: `d${i}`, status: 'completed', createdAt: 1_700_000_000_000 - i },
        })),
      ),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments?page_size=25`,
    );
    const res = await listGET(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(25);
    expect(body.next_page_token).toBe('deploy-25');
  });

  it('clamps page_size above MAX', async () => {
    mocks.collectionGet.mockResolvedValueOnce(querySnapshot([]));
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments?page_size=999`,
    );
    await listGET(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(mocks.limit).toHaveBeenCalledWith(101); // MAX_PAGE_SIZE (100) + 1 lookahead
  });

  it('200 — scope-pass: site=<id>:read on api key', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'site', id: SITE, permissions: ['read'] }]),
    );
    mocks.collectionGet.mockResolvedValueOnce(querySnapshot([]));
    const req = createMockRequest(`http://localhost/api/sites/${SITE}/deployments`);
    const res = await listGET(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(200);
  });

  it('403 scope_insufficient when key lacks site:read', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'site', id: SITE, permissions: ['write'] }]),
    );
    const req = createMockRequest(`http://localhost/api/sites/${SITE}/deployments`);
    const res = await listGET(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('scope_insufficient');
  });
});

/* ========================================================================== */
/*  POST /api/sites/{siteId}/deployments — create                             */
/* ========================================================================== */
describe('POST /api/sites/{siteId}/deployments', () => {
  it('201 happy path: writes deployment doc + fans out commands', async () => {
    mocks.get.mockResolvedValue(docSnapshot(SITE, {})); // site doc, no quota override
    const req = createMockRequest(`http://localhost/api/sites/${SITE}/deployments`, {
      method: 'POST',
      body: validCreateBody,
    });
    const res = await createPOST(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.deploymentId).toMatch(/^deploy-\d+$/);
    expect(body.targets).toHaveLength(2);

    // Deployment doc + fan-out merges (one per machine).
    const mergeCalls = mocks.set.mock.calls.filter(
      (c: unknown[]) => (c[1] as { merge?: boolean })?.merge === true,
    );
    expect(mergeCalls).toHaveLength(2);
    const firstCmd = mergeCalls[0][0];
    const cmdKey = Object.keys(firstCmd)[0];
    expect(firstCmd[cmdKey].type).toBe('install_software');
    expect(mocks.update).toHaveBeenCalledWith({ status: 'in_progress' });

    expect(mockedEmit).toHaveBeenCalledTimes(1);
    expect(mockedEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'deployment_mutated',
        siteId: SITE,
        attributes: expect.objectContaining({ verb: 'create', target_count: 2 }),
      }),
    );
  });

  it('400 when name missing', async () => {
    mocks.get.mockResolvedValue(docSnapshot(SITE, {}));
    const req = createMockRequest(`http://localhost/api/sites/${SITE}/deployments`, {
      method: 'POST',
      body: { ...validCreateBody, name: '' },
    });
    const res = await createPOST(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(400);
  });

  it('400 when installer_url is not https', async () => {
    mocks.get.mockResolvedValue(docSnapshot(SITE, {}));
    const req = createMockRequest(`http://localhost/api/sites/${SITE}/deployments`, {
      method: 'POST',
      body: { ...validCreateBody, installer_url: 'http://example.com/setup.exe' },
    });
    const res = await createPOST(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(400);
  });

  it('400 when machines is empty', async () => {
    mocks.get.mockResolvedValue(docSnapshot(SITE, {}));
    const req = createMockRequest(`http://localhost/api/sites/${SITE}/deployments`, {
      method: 'POST',
      body: { ...validCreateBody, machines: [] },
    });
    const res = await createPOST(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(400);
  });

  it('400 when sha256_checksum has wrong length', async () => {
    mocks.get.mockResolvedValue(docSnapshot(SITE, {}));
    const req = createMockRequest(`http://localhost/api/sites/${SITE}/deployments`, {
      method: 'POST',
      body: { ...validCreateBody, sha256_checksum: 'deadbeef' },
    });
    const res = await createPOST(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(400);
  });

  it('413 over_quota when machines exceed default 100', async () => {
    mocks.get.mockResolvedValue(docSnapshot(SITE, {})); // no override
    const req = createMockRequest(`http://localhost/api/sites/${SITE}/deployments`, {
      method: 'POST',
      body: {
        ...validCreateBody,
        machines: Array.from({ length: 101 }, (_, i) => `m-${i}`),
      },
    });
    const res = await createPOST(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.code).toBe('over_quota');
    expect(body.quota).toEqual({ max_targets: 100, requested: 101 });
  });

  it('413 over_quota honors per-site deployQuota override', async () => {
    mocks.get.mockResolvedValue(docSnapshot(SITE, { deployQuota: 5 }));
    const req = createMockRequest(`http://localhost/api/sites/${SITE}/deployments`, {
      method: 'POST',
      body: {
        ...validCreateBody,
        machines: Array.from({ length: 6 }, (_, i) => `m-${i}`),
      },
    });
    const res = await createPOST(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.quota.max_targets).toBe(5);
  });

  it('201 — scope-pass: site=<id>:write on api key', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'site', id: SITE, permissions: ['write'] }]),
    );
    mocks.get.mockResolvedValue(docSnapshot(SITE, {}));
    const req = createMockRequest(`http://localhost/api/sites/${SITE}/deployments`, {
      method: 'POST',
      body: validCreateBody,
    });
    const res = await createPOST(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(201);
  });

  it('403 scope_insufficient when key has only read', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'site', id: SITE, permissions: ['read'] }]),
    );
    const req = createMockRequest(`http://localhost/api/sites/${SITE}/deployments`, {
      method: 'POST',
      body: validCreateBody,
    });
    const res = await createPOST(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('scope_insufficient');
  });

  it('replays cached response on Idempotency-Key hit with matching body', async () => {
    const crypto = await import('crypto');
    const raw = JSON.stringify(validCreateBody);
    const bodyHash = crypto.createHash('sha256').update(raw).digest('hex');
    // First doc.get() = idempotency cache lookup
    mocks.get.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        userId: 'user-1',
        environment: 'unknown',
        key: 'idem-create-1',
        bodyHash,
        status: 201,
        headers: { 'content-type': 'application/json' },
        body: '{"deploymentId":"deploy-replayed","siteId":"site-alpha"}',
        expiresAt: Date.now() + 60_000,
      }),
    });

    const req = createMockRequest(`http://localhost/api/sites/${SITE}/deployments`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'idem-create-1' },
      body: validCreateBody,
    });
    const res = await createPOST(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(201);
    expect(res.headers.get('Idempotent-Replayed')).toBe('true');
    const body = await res.json();
    expect(body.deploymentId).toBe('deploy-replayed');
    // The handler should NOT have written anything on a replay.
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('422 idempotency_key_mismatch when same key, different body', async () => {
    // Cache holds a different body hash.
    mocks.get.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        userId: 'user-1',
        environment: 'unknown',
        key: 'idem-create-2',
        bodyHash: 'a'.repeat(64),
        status: 201,
        headers: {},
        body: '{}',
        expiresAt: Date.now() + 60_000,
      }),
    });

    const req = createMockRequest(`http://localhost/api/sites/${SITE}/deployments`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'idem-create-2' },
      body: validCreateBody,
    });
    const res = await createPOST(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('idempotency_key_mismatch');
  });
});

/* ========================================================================== */
/*  GET /api/sites/{siteId}/deployments/{deploymentId} — detail               */
/* ========================================================================== */
describe('GET /api/sites/{siteId}/deployments/{deploymentId}', () => {
  it('200 with full deployment detail', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot(DEPLOYMENT, {
        name: 'detail-test',
        installer_name: 'vlc.exe',
        installer_url: 'https://example.com/vlc.exe',
        silent_flags: '/S',
        targets: [{ machineId: 'm1', status: 'completed' }],
        status: 'completed',
        createdAt: 1_700_000_000_000,
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}`,
    );
    const res = await detailGET(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(DEPLOYMENT);
    expect(body.name).toBe('detail-test');
    expect(body.targets).toHaveLength(1);
  });

  it('404 when deployment not found', async () => {
    mocks.get.mockResolvedValueOnce(docSnapshot(DEPLOYMENT, null));
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}`,
    );
    const res = await detailGET(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(404);
  });

  it('403 scope_insufficient when key lacks site:read', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'site', id: SITE, permissions: ['admin'] }]),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}`,
    );
    const res = await detailGET(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('scope_insufficient');
  });
});

/* ========================================================================== */
/*  POST .../retry                                                            */
/* ========================================================================== */
describe('POST /api/sites/{siteId}/deployments/{deploymentId}/retry', () => {
  it('200 — re-queues install for failed targets only', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot(DEPLOYMENT, {
        installer_name: 'vlc.exe',
        installer_url: 'https://example.com/vlc.exe',
        silent_flags: '/S',
        targets: [
          { machineId: 'm1', status: 'completed' },
          { machineId: 'm2', status: 'failed', error: 'oh no' },
          { machineId: 'm3', status: 'failed' },
        ],
        status: 'partial',
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/retry`,
      { method: 'POST', body: {} },
    );
    const res = await retryPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.retried).toBe(2);
    expect(body.machine_ids).toEqual(['m2', 'm3']);

    // Two install_software commands re-queued (one per failed target).
    const mergeCalls = mocks.set.mock.calls.filter(
      (c: unknown[]) => (c[1] as { merge?: boolean })?.merge === true,
    );
    expect(mergeCalls).toHaveLength(2);
    expect(mergeCalls[0][0][Object.keys(mergeCalls[0][0])[0]].retry_attempt).toBe(true);

    // Targets array updated: failed → pending, error dropped, retriedAt set.
    const updatePayload = mocks.update.mock.calls[0][0];
    expect(updatePayload.status).toBe('in_progress');
    const m2 = updatePayload.targets.find((t: { machineId: string }) => t.machineId === 'm2');
    expect(m2.status).toBe('pending');
    expect(m2.error).toBeUndefined();
    expect(m2.retriedAt).toBeDefined();
    const m1 = updatePayload.targets.find((t: { machineId: string }) => t.machineId === 'm1');
    expect(m1.status).toBe('completed'); // unchanged

    expect(mockedEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'deployment_mutated',
        attributes: expect.objectContaining({ verb: 'retry', retried_count: 2 }),
      }),
    );
  });

  it('404 when deployment not found', async () => {
    mocks.get.mockResolvedValueOnce(docSnapshot(DEPLOYMENT, null));
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/retry`,
      { method: 'POST', body: {} },
    );
    const res = await retryPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(404);
  });

  it('409 when no targets are in failed state', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot(DEPLOYMENT, {
        installer_name: 'vlc.exe',
        installer_url: 'https://example.com/vlc.exe',
        silent_flags: '/S',
        targets: [{ machineId: 'm1', status: 'completed' }],
        status: 'completed',
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/retry`,
      { method: 'POST', body: {} },
    );
    const res = await retryPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('no_failed_targets');
  });

  it('403 scope_insufficient when key lacks site:write', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'site', id: SITE, permissions: ['read'] }]),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/retry`,
      { method: 'POST', body: {} },
    );
    const res = await retryPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('scope_insufficient');
  });
});

/* ========================================================================== */
/*  POST .../cancel                                                           */
/* ========================================================================== */
describe('POST /api/sites/{siteId}/deployments/{deploymentId}/cancel', () => {
  it('200 — cancels pending targets, leaves installing/completed alone', async () => {
    // 1st get: deployment doc. Subsequent gets: pending command docs per
    // cancellable target. We have one cancellable (`pending`) target.
    mocks.get
      .mockResolvedValueOnce(
        docSnapshot(DEPLOYMENT, {
          installer_name: 'vlc.exe',
          targets: [
            { machineId: 'm1', status: 'installing' },
            { machineId: 'm2', status: 'pending' },
            { machineId: 'm3', status: 'completed' },
          ],
          status: 'in_progress',
        }),
      )
      .mockResolvedValueOnce({
        exists: true,
        data: () => ({
          install_deploy_xxx_m2_1: {
            type: 'install_software',
            deployment_id: DEPLOYMENT,
          },
          some_other_command: { type: 'reboot_machine' },
        }),
      });
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/cancel`,
      { method: 'POST', body: {} },
    );
    const res = await cancelPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cancelled).toBe(1);
    expect(body.machine_ids).toEqual(['m2']);

    // Pending command for m2 was deleted.
    const pendingUpdate = mocks.update.mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>).install_deploy_xxx_m2_1 !== undefined,
    );
    expect(pendingUpdate).toBeDefined();

    // Deployment update: m1/m3 untouched, m2 → cancelled. Status NOT
    // terminal (m1 is still installing).
    const deploymentUpdate = mocks.update.mock.calls.find(
      (c: unknown[]) => (c[0] as { targets?: unknown }).targets !== undefined,
    );
    expect(deploymentUpdate).toBeDefined();
    const updateArg = deploymentUpdate![0] as {
      targets: Array<{ machineId: string; status: string }>;
      status?: string;
    };
    expect(updateArg.status).toBeUndefined();
    expect(updateArg.targets.find((t) => t.machineId === 'm2')!.status).toBe('cancelled');
    expect(updateArg.targets.find((t) => t.machineId === 'm1')!.status).toBe('installing');
  });

  it('200 — flips deployment status to cancelled when every target terminal-cancelled', async () => {
    mocks.get
      .mockResolvedValueOnce(
        docSnapshot(DEPLOYMENT, {
          installer_name: 'vlc.exe',
          targets: [{ machineId: 'm1', status: 'pending' }],
          status: 'in_progress',
        }),
      )
      .mockResolvedValueOnce({ exists: false });
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/cancel`,
      { method: 'POST', body: {} },
    );
    const res = await cancelPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('cancelled');
  });

  it('404 when deployment not found', async () => {
    mocks.get.mockResolvedValueOnce(docSnapshot(DEPLOYMENT, null));
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/cancel`,
      { method: 'POST', body: {} },
    );
    const res = await cancelPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(404);
  });

  it('409 when nothing is cancellable', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot(DEPLOYMENT, {
        installer_name: 'vlc.exe',
        targets: [{ machineId: 'm1', status: 'completed' }],
        status: 'completed',
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/cancel`,
      { method: 'POST', body: {} },
    );
    const res = await cancelPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('no_cancellable_targets');
  });

  it('403 scope_insufficient when key lacks site:write', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'site', id: SITE, permissions: ['read'] }]),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/cancel`,
      { method: 'POST', body: {} },
    );
    const res = await cancelPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('scope_insufficient');
  });
});

/* ========================================================================== */
/*  POST .../uninstall                                                        */
/* ========================================================================== */
describe('POST /api/sites/{siteId}/deployments/{deploymentId}/uninstall', () => {
  it('200 — queues uninstall_software per target + flips status', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'site', id: SITE, permissions: ['admin'] }]),
    );
    mocks.get.mockResolvedValueOnce(
      docSnapshot(DEPLOYMENT, {
        installer_name: 'vlc.exe',
        targets: [
          { machineId: 'm1', status: 'completed' },
          { machineId: 'm2', status: 'completed' },
        ],
        status: 'completed',
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/uninstall`,
      { method: 'POST', body: {} },
    );
    const res = await uninstallPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.queued).toBe(2);
    expect(body.status).toBe('uninstalling');

    const mergeCalls = mocks.set.mock.calls.filter(
      (c: unknown[]) => (c[1] as { merge?: boolean })?.merge === true,
    );
    expect(mergeCalls).toHaveLength(2);
    const firstCmd = mergeCalls[0][0];
    const cmdKey = Object.keys(firstCmd)[0];
    expect(firstCmd[cmdKey].type).toBe('uninstall_software');
    expect(firstCmd[cmdKey].installer_name).toBe('vlc.exe');

    const updateCall = mocks.update.mock.calls[0][0];
    expect(updateCall.status).toBe('uninstalling');

    expect(mockedEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'deployment_mutated',
        attributes: expect.objectContaining({ verb: 'uninstall', target_count: 2 }),
      }),
    );
  });

  it('404 when deployment not found', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'site', id: SITE, permissions: ['admin'] }]),
    );
    mocks.get.mockResolvedValueOnce(docSnapshot(DEPLOYMENT, null));
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/uninstall`,
      { method: 'POST', body: {} },
    );
    const res = await uninstallPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(404);
  });

  it('409 when deployment has no targets', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'site', id: SITE, permissions: ['admin'] }]),
    );
    mocks.get.mockResolvedValueOnce(
      docSnapshot(DEPLOYMENT, {
        installer_name: 'vlc.exe',
        targets: [],
        status: 'completed',
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/uninstall`,
      { method: 'POST', body: {} },
    );
    const res = await uninstallPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('no_targets');
  });

  it('403 scope_insufficient when key has site:write but not admin', async () => {
    // Uninstall is privileged: requires `admin`, not just `write`.
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'site', id: SITE, permissions: ['write'] }]),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/uninstall`,
      { method: 'POST', body: {} },
    );
    const res = await uninstallPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('scope_insufficient');
  });

  it('200 — scope-pass with site=<id>:admin', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'site', id: SITE, permissions: ['admin'] }]),
    );
    mocks.get.mockResolvedValueOnce(
      docSnapshot(DEPLOYMENT, {
        installer_name: 'vlc.exe',
        targets: [{ machineId: 'm1', status: 'completed' }],
        status: 'completed',
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/deployments/${DEPLOYMENT}/uninstall`,
      { method: 'POST', body: {} },
    );
    const res = await uninstallPOST(req, {
      params: Promise.resolve({ siteId: SITE, deploymentId: DEPLOYMENT }),
    });
    expect(res.status).toBe(200);
  });
});
