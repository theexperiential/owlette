/** @jest-environment node */

import { ApiAuthError } from '@/lib/apiAuth.server';
import { createMockRequest } from './helpers/utils';
import { mocks, mockDbFactory, docSnapshot, querySnapshot } from './helpers/firestore-mock';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock('@/lib/firebase-admin', () => ({ getAdminDb: () => mockDbFactory() }));
jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

const mockResolveAuth = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return { ...actual, resolveAuth: (...a: unknown[]) => mockResolveAuth(...a) };
});

import { GET as whoamiGET } from '@/app/api/whoami/route';
import { GET as versionGET, CURRENT_ROOST_VERSION } from '@/app/api/version/route';

describe('GET /api/version', () => {
  it('returns current + supported versions without auth', async () => {
    const res = await versionGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.current).toBe(CURRENT_ROOST_VERSION);
    expect(body.supported).toContain(CURRENT_ROOST_VERSION);
  });
});

describe('GET /api/whoami', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mocks.collectionGet.mockResolvedValue(querySnapshot([]));
  });

  it('401 when auth resolution fails', async () => {
    mockResolveAuth.mockRejectedValueOnce(new ApiAuthError(401, 'Unauthorized'));
    const req = createMockRequest('http://localhost/api/whoami');
    const res = await whoamiGET(req);
    expect(res.status).toBe(401);
  });

  it('401 with token_expired code when key is past expiresAt', async () => {
    mockResolveAuth.mockRejectedValueOnce(
      new ApiAuthError(401, 'API key expired', {
        code: 'token_expired',
        details: { expiredAt: 1_700_000_000_000 },
      }),
    );
    const req = createMockRequest('http://localhost/api/whoami');
    const res = await whoamiGET(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe('token_expired');
    expect(body.expiredAt).toBe(1_700_000_000_000);
  });

  it('returns identity + null key for session auth', async () => {
    mockResolveAuth.mockResolvedValueOnce({ userId: 'user-1', keyContext: null });
    // Reads in order:
    //  1. users/user-1 (main profile)
    //  2. sites/site-a/roost/quota (quota doc for primary site)
    mocks.get
      .mockResolvedValueOnce(docSnapshot('user-1', {
        email: 'dylan@example.com',
        role: 'member',
        sites: ['site-a'],
      }))
      .mockResolvedValueOnce(docSnapshot('quota', null));

    const req = createMockRequest('http://localhost/api/whoami');
    const res = await whoamiGET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe('user-1');
    expect(body.email).toBe('dylan@example.com');
    expect(body.role).toBe('member');
    expect(body.key).toBeNull();
    expect(body.rateLimit).toBeDefined();
    expect(body.primarySiteId).toBe('site-a');
  });

  it('returns key metadata for API-key auth', async () => {
    mockResolveAuth.mockResolvedValueOnce({
      userId: 'user-2',
      keyContext: {
        keyId: 'k-xyz',
        scopes: [{ resource: 'site', id: 'site-b', permissions: ['write'] }],
        environment: 'live',
        expiresAt: Date.now() + 60_000,
        isLegacy: false,
      },
    });
    // Reads in order:
    //  1. users/user-2
    //  2. users/user-2/api_keys/k-xyz (metadata enrichment)
    //  3. sites/site-b/roost/quota
    mocks.get
      .mockResolvedValueOnce(docSnapshot('user-2', {
        email: 'api@example.com', role: 'member', sites: [],
      }))
      .mockResolvedValueOnce(docSnapshot('k-xyz', {
        name: 'ci-publisher',
        keyPrefix: 'owk_live_XXXXX',
      }))
      .mockResolvedValueOnce(docSnapshot('quota', null));

    const req = createMockRequest('http://localhost/api/whoami');
    const res = await whoamiGET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key).not.toBeNull();
    expect(body.key.keyId).toBe('k-xyz');
    expect(body.key.name).toBe('ci-publisher');
    expect(body.key.environment).toBe('live');
    expect(body.primarySiteId).toBe('site-b');
  });

  it('primary site falls back to user sites[] when scope is wildcard', async () => {
    mockResolveAuth.mockResolvedValueOnce({
      userId: 'user-3',
      keyContext: {
        keyId: 'k-3',
        scopes: [{ resource: 'site', id: '*', permissions: ['read'] }],
        environment: 'test',
        expiresAt: Date.now() + 60_000,
        isLegacy: false,
      },
    });
    mocks.get
      .mockResolvedValueOnce(docSnapshot('user-3', { sites: ['site-xyz'] }))
      .mockResolvedValueOnce(docSnapshot('k-3', null))
      .mockResolvedValueOnce(docSnapshot('quota', null));

    const req = createMockRequest('http://localhost/api/whoami');
    const res = await whoamiGET(req);
    const body = await res.json();
    expect(body.primarySiteId).toBe('site-xyz');
  });
});
