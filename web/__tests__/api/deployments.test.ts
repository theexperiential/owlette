/** @jest-environment node */

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
  getAdminAuth: () => ({ verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')) }),
}));
jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
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

import { POST as deployPOST } from '@/app/api/roosts/[roostId]/deploy/route';
import { GET as deploymentsGET } from '@/app/api/roosts/[roostId]/deployments/route';

const SITE = 'site-dep';
const ROOST = 'rst_deployroot1';
const MANIFEST = 'manifest_deploy1';

function authed() {
  mockResolveAuth.mockResolvedValue({
    userId: 'user-1',
    keyContext: null,
  });
  mockAssertSite.mockResolvedValue({ siteId: SITE, siteData: {} });
}

beforeEach(() => {
  jest.clearAllMocks();
  authed();
  mocks.set.mockResolvedValue(undefined);
  mocks.get.mockImplementation(() => Promise.resolve(docSnapshot('any', {})));
  mocks.collectionGet.mockResolvedValue(querySnapshot([]));
});

describe('POST /api/roosts/{id}/deploy', () => {
  it('404 when roost does not exist', async () => {
    mocks.get.mockResolvedValueOnce(docSnapshot(ROOST, null));
    const req = createMockRequest(
      `http://localhost/api/roosts/${ROOST}/deploy`,
      { method: 'POST', body: { siteId: SITE } },
    );
    const res = await deployPOST(req, { params: Promise.resolve({ roostId: ROOST }) });
    expect(res.status).toBe(404);
  });

  it('409 when roost is tombstoned', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot(ROOST, {
        deletedAt: 1_700_000_000_000,
        currentManifestId: MANIFEST,
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/roosts/${ROOST}/deploy`,
      { method: 'POST', body: { siteId: SITE } },
    );
    const res = await deployPOST(req, { params: Promise.resolve({ roostId: ROOST }) });
    expect(res.status).toBe(409);
  });

  it('400 when no current manifest and none provided', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot(ROOST, { targets: ['m-1'] }), // no currentManifestId
    );
    const req = createMockRequest(
      `http://localhost/api/roosts/${ROOST}/deploy`,
      { method: 'POST', body: { siteId: SITE } },
    );
    const res = await deployPOST(req, { params: Promise.resolve({ roostId: ROOST }) });
    expect(res.status).toBe(400);
  });

  it('400 when no machines (roost targets empty and no override)', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot(ROOST, {
        currentManifestId: MANIFEST,
        manifestUrl: 'https://r2/.../manifest.json',
        targets: [],
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/roosts/${ROOST}/deploy`,
      { method: 'POST', body: { siteId: SITE } },
    );
    const res = await deployPOST(req, { params: Promise.resolve({ roostId: ROOST }) });
    expect(res.status).toBe(400);
  });

  it('dryRun returns plan without side effects', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot(ROOST, {
        currentManifestId: MANIFEST,
        manifestUrl: 'https://r2/.../manifest.json',
        targets: ['m-1', 'm-2', 'm-3'],
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/roosts/${ROOST}/deploy`,
      { method: 'POST', body: { siteId: SITE, dryRun: true } },
    );
    const res = await deployPOST(req, { params: Promise.resolve({ roostId: ROOST }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dryRun).toBe(true);
    expect(body.manifestId).toBe(MANIFEST);
    expect(body.canary.length).toBeGreaterThan(0);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  // Note: a full "201 writes + queues" integration case needs a
  // db.batch() mock that the shared firestore-mock doesn't surface. The
  // dryRun test above exercises the plan-computation path without
  // requiring a batch. Covered more thoroughly by the firestore-emulator
  // suite (deferred to wave 4 e2e).

  it('returns alreadyRunning=true on idempotent re-trigger for active rollout', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot(ROOST, {
        currentManifestId: MANIFEST,
        manifestUrl: 'https://r2/.../manifest.json',
        targets: ['m-1'],
      }),
    );
    mocks.get.mockResolvedValueOnce(
      docSnapshot(MANIFEST, {
        stage: 'canary',
        canary: ['m-1'],
        fleet: [],
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/roosts/${ROOST}/deploy`,
      { method: 'POST', body: { siteId: SITE } },
    );
    const res = await deployPOST(req, { params: Promise.resolve({ roostId: ROOST }) });
    const body = await res.json();
    expect(body.alreadyRunning).toBe(true);
  });
});

describe('GET /api/roosts/{id}/deployments', () => {
  it('400 when siteId missing', async () => {
    const req = createMockRequest(
      `http://localhost/api/roosts/${ROOST}/deployments`,
    );
    const res = await deploymentsGET(req, { params: Promise.resolve({ roostId: ROOST }) });
    expect(res.status).toBe(400);
  });

  it('returns paginated rollout list', async () => {
    mocks.collectionGet.mockResolvedValueOnce(
      querySnapshot([
        {
          id: MANIFEST,
          data: {
            manifestId: MANIFEST,
            stage: 'canary',
            canary: ['m-1'],
            fleet: [],
            manifestUrl: 'https://r2/.../x.json',
            extractRoot: '~',
            triggeredBy: 'user-1',
          },
        },
      ]),
    );
    const req = createMockRequest(
      `http://localhost/api/roosts/${ROOST}/deployments?siteId=${SITE}`,
    );
    const res = await deploymentsGET(req, { params: Promise.resolve({ roostId: ROOST }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rollouts).toHaveLength(1);
    expect(body.rollouts[0].rolloutId).toBe(MANIFEST);
    expect(body.rollouts[0].stage).toBe('canary');
  });
});
