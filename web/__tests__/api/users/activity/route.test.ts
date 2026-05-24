/** @jest-environment node */

/**
 * Public users-api — http-shape tests for `GET /api/users/activity`
 * (api-sprint wave 3 track 3B).
 *
 * Mirrors the harness in `__tests__/api/users.test.ts`: path-keyed `docStore`
 * + `collectionDocs`, mocked `resolveAuth`, real `requirePlatformAuthAndScope`
 * underneath so superadmin gating is exercised end-to-end. Adds a controllable
 * `getUsers` mock to exercise batching, unordered results, and notFound.
 */

import { createMockRequest } from '../../helpers/utils';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: jest.fn(),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

/* -------------------------------------------------------------------------- */
/*  Auth mock                                                                 */
/* -------------------------------------------------------------------------- */

const mockResolveAuth = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
  };
});

jest.mock('@/lib/rateLimit.server', () => ({
  checkRateLimit: jest.fn(async () => ({ ok: true })),
}));

jest.mock('@/lib/securityConfig.server', () => ({
  securityConfig: {
    read: jest.fn(async () => ({
      capability_enforcement: true,
      rate_limit_enforcement: true,
    })),
  },
}));

/* -------------------------------------------------------------------------- */
/*  Firestore mock — keyed by collection path                                 */
/* -------------------------------------------------------------------------- */

interface DocStore {
  data: Record<string, unknown> | null;
}

const docStore: Record<string, DocStore> = {};
const collectionDocs: Record<
  string,
  Array<{ id: string; data: Record<string, unknown> }>
> = {};

function pathFor(parts: string[]): string {
  return parts.join('/');
}

function makeDocRef(parts: string[]): unknown {
  const path = pathFor(parts);
  const docId = parts[parts.length - 1];
  return {
    id: docId,
    path,
    get: jest.fn(async () => {
      const entry = docStore[path];
      return {
        exists: !!entry && entry.data !== null,
        id: docId,
        data: () => entry?.data ?? undefined,
      };
    }),
  };
}

function makeCollectionRef(parts: string[]): unknown {
  const path = pathFor(parts);

  const ref: Record<string, unknown> = {
    doc: (id: string) => makeDocRef([...parts, id]),
    // `.select()` with no args projects to doc ids only (route uses this to
    // collect all uids cheaply). The mock ignores the projection and returns
    // the seeded docs.
    select: () => ref,
    get: jest.fn(async () => {
      const docs = (collectionDocs[path] || []).slice();
      return {
        docs: docs.map((d) => ({
          id: d.id,
          exists: true,
          data: () => d.data,
        })),
      };
    }),
  };
  return ref;
}

/* -------------------------------------------------------------------------- */
/*  Firebase Auth getUsers mock                                               */
/* -------------------------------------------------------------------------- */

const mockGetUsers = jest.fn();

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => makeCollectionRef([name]),
  }),
  getAdminAuth: () => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')),
    getUsers: (...a: unknown[]) => mockGetUsers(...a),
  }),
  getAdminStorage: () => ({ bucket: () => ({}) }),
}));

/* -------------------------------------------------------------------------- */
/*  Imports come AFTER mocks                                                  */
/* -------------------------------------------------------------------------- */

import { GET as activityGET } from '@/app/api/users/activity/route';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

function authedAsSuperadminWithKey(userId = 'user-superadmin'): void {
  mockResolveAuth.mockResolvedValue({
    userId,
    keyContext: {
      keyId: 'key_test',
      environment: 'live',
      isLegacy: false,
      scopes: [{ resource: 'user', id: '*', permissions: ['read'] }],
      expiresAt: null,
    },
  });
  seedUser(userId, { role: 'superadmin', email: 'sa@example.com' });
}

function authedAsNonSuperadminWithKey(): void {
  mockResolveAuth.mockResolvedValue({
    userId: 'user-regular',
    keyContext: {
      keyId: 'key_test',
      environment: 'live',
      isLegacy: false,
      scopes: [{ resource: 'user', id: '*', permissions: ['read'] }],
      expiresAt: null,
    },
  });
  seedUser('user-regular', { role: 'admin', email: 'admin@example.com' });
}

function seedUser(uid: string, data: Record<string, unknown>): void {
  const path = `users/${uid}`;
  const merged = { email: `${uid}@example.com`, role: 'member', sites: [], ...data };
  docStore[path] = { data: merged };
  if (!collectionDocs['users']) collectionDocs['users'] = [];
  const idx = collectionDocs['users'].findIndex((d) => d.id === uid);
  if (idx >= 0) collectionDocs['users'][idx] = { id: uid, data: merged };
  else collectionDocs['users'].push({ id: uid, data: merged });
}

function userRecord(
  uid: string,
  meta: { lastSignInTime?: string; lastRefreshTime?: string; disabled?: boolean } = {},
): Record<string, unknown> {
  return {
    uid,
    disabled: meta.disabled ?? false,
    metadata: {
      lastSignInTime: meta.lastSignInTime ?? '',
      lastRefreshTime: meta.lastRefreshTime ?? '',
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(docStore)) delete docStore[k];
  for (const k of Object.keys(collectionDocs)) delete collectionDocs[k];
});

/* ========================================================================== */
/*  GET /api/users/activity                                                   */
/* ========================================================================== */

describe('GET /api/users/activity', () => {
  it('returns 200 + the activity map for a superadmin caller', async () => {
    authedAsSuperadminWithKey();
    seedUser('alice', { role: 'admin' });
    seedUser('bob', { role: 'member' });

    mockGetUsers.mockResolvedValueOnce({
      users: [
        userRecord('user-superadmin', {
          lastSignInTime: 'Mon, 01 Jan 2024 00:00:00 GMT',
          lastRefreshTime: 'Mon, 01 Jan 2024 01:00:00 GMT',
          disabled: false,
        }),
        userRecord('alice', {
          lastSignInTime: 'Tue, 02 Jan 2024 00:00:00 GMT',
          lastRefreshTime: 'Tue, 02 Jan 2024 01:00:00 GMT',
          disabled: true,
        }),
        userRecord('bob', {
          lastSignInTime: 'Wed, 03 Jan 2024 00:00:00 GMT',
          lastRefreshTime: 'Wed, 03 Jan 2024 01:00:00 GMT',
          disabled: false,
        }),
      ],
      notFound: [],
    });

    const req = createMockRequest('http://localhost/api/users/activity');
    const res = await activityGET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.activity.alice).toEqual({
      lastSignInTime: 'Tue, 02 Jan 2024 00:00:00 GMT',
      lastRefreshTime: 'Tue, 02 Jan 2024 01:00:00 GMT',
      disabled: true,
    });
    expect(body.activity.bob.disabled).toBe(false);
    expect(body.activity['user-superadmin'].lastSignInTime).toBe(
      'Mon, 01 Jan 2024 00:00:00 GMT',
    );
    // Projects to exactly the three fields — no PII spread.
    expect(Object.keys(body.activity.alice).sort()).toEqual([
      'disabled',
      'lastRefreshTime',
      'lastSignInTime',
    ]);
  });

  it('rejects a non-superadmin caller with 403', async () => {
    authedAsNonSuperadminWithKey();

    const req = createMockRequest('http://localhost/api/users/activity');
    const res = await activityGET(req);

    expect(res.status).toBe(403);
    expect(mockGetUsers).not.toHaveBeenCalled();
  });

  it('returns an empty activity map when there are no users', async () => {
    authedAsSuperadminWithKey();
    // Empty the `users` collection listing (drives `.select().get()`) while
    // leaving the caller's doc in `docStore` so the superadmin role gate —
    // which reads `users/{uid}` via a doc ref — still passes.
    collectionDocs['users'] = [];

    const req = createMockRequest('http://localhost/api/users/activity');
    const res = await activityGET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.activity).toEqual({});
    expect(mockGetUsers).not.toHaveBeenCalled();
  });

  it('batches uids into chunks of at most 100 (150 uids → 2 getUsers calls)', async () => {
    authedAsSuperadminWithKey();
    for (let i = 0; i < 149; i++) {
      seedUser(`u-${String(i).padStart(3, '0')}`, { role: 'member' });
    }
    // 149 seeded + 1 auth-fixture superadmin = 150 uids.

    mockGetUsers.mockResolvedValue({ users: [], notFound: [] });

    const req = createMockRequest('http://localhost/api/users/activity');
    const res = await activityGET(req);

    expect(res.status).toBe(200);
    expect(mockGetUsers).toHaveBeenCalledTimes(2);
    expect(mockGetUsers.mock.calls[0][0]).toHaveLength(100);
    expect(mockGetUsers.mock.calls[1][0]).toHaveLength(50);
  });

  it('keys the output map by record.uid (unordered) and omits notFound uids', async () => {
    authedAsSuperadminWithKey();
    seedUser('alice', { role: 'admin' });
    seedUser('bob', { role: 'member' });
    seedUser('carol', { role: 'member' });

    // Return records in a different order than requested, and report `bob` as
    // notFound so it must be absent from the output.
    mockGetUsers.mockResolvedValueOnce({
      users: [
        userRecord('carol', { lastSignInTime: 'C' }),
        userRecord('user-superadmin', { lastSignInTime: 'SA' }),
        userRecord('alice', { lastSignInTime: 'A' }),
      ],
      notFound: [{ uid: 'bob' }],
    });

    const req = createMockRequest('http://localhost/api/users/activity');
    const res = await activityGET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.activity.alice.lastSignInTime).toBe('A');
    expect(body.activity.carol.lastSignInTime).toBe('C');
    expect(body.activity['user-superadmin'].lastSignInTime).toBe('SA');
    expect(body.activity.bob).toBeUndefined();
  });

  it('coerces empty-string metadata to null', async () => {
    authedAsSuperadminWithKey();

    mockGetUsers.mockResolvedValueOnce({
      users: [userRecord('user-superadmin', { lastSignInTime: '', lastRefreshTime: '' })],
      notFound: [],
    });

    const req = createMockRequest('http://localhost/api/users/activity');
    const res = await activityGET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.activity['user-superadmin']).toEqual({
      lastSignInTime: null,
      lastRefreshTime: null,
      disabled: false,
    });
  });
});
