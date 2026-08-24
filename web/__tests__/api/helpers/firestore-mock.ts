/**
 * Shared Firestore mocks + data factories for API route-handler tests.
 *
 * This module never calls `jest.mock()` itself — Jest hoists those, so each
 * test file must declare them at its own top level and point them at the
 * objects exported here (e.g.
 * `jest.mock('@/lib/firebase-admin', () => ({ getAdminDb: () => mockDbFactory() }))`).
 */

export const mocks = {
  /** doc().get() */
  get: jest.fn(),
  /** doc().set() */
  set: jest.fn().mockResolvedValue(undefined),
  /** doc().update() */
  update: jest.fn().mockResolvedValue(undefined),
  /** doc().delete() */
  del: jest.fn().mockResolvedValue(undefined),
  /** db.batch().set() */
  batchSet: jest.fn(),
  /** db.batch().delete() */
  batchDelete: jest.fn(),
  /** db.batch().commit() */
  batchCommit: jest.fn().mockResolvedValue(undefined),
  /** collection().orderBy() — chainable */
  orderBy: jest.fn().mockReturnThis(),
  /** collection().limit() — chainable */
  limit: jest.fn().mockReturnThis(),
  /** collection().startAfter() — chainable */
  startAfter: jest.fn().mockReturnThis(),
  /** collection().where() — chainable */
  where: jest.fn().mockReturnThis(),
  /** terminal .get() on a query chain */
  collectionGet: jest.fn(),
  /** explicit data for top-level sites/{siteId} document reads */
  siteDocs: new Map<string, Record<string, unknown> | null>(),
  /** requireAdminOrIdToken */
  requireAdmin: jest.fn().mockResolvedValue({ userId: 'test-admin' }),
};

/** Recursive collection/doc tree. */
function buildCollection(path = ''): Record<string, unknown> {
  return {
    doc: (_id?: string) => buildDoc(`${path}/${_id ?? 'auto'}`),
    orderBy: mocks.orderBy,
    limit: mocks.limit,
    startAfter: mocks.startAfter,
    where: mocks.where,
    get: mocks.collectionGet,
  };
}

function buildDoc(path: string): Record<string, unknown> {
  return {
    get: () => {
      const parts = path.split('/').filter(Boolean);
      if (parts.length === 2 && parts[0] === 'sites') {
        if (mocks.siteDocs.has(parts[1])) {
          return Promise.resolve(docSnapshot(parts[1], mocks.siteDocs.get(parts[1]) ?? null));
        }
        return Promise.resolve(docSnapshot(parts[1], {}));
      }
      return mocks.get();
    },
    set: mocks.set,
    update: mocks.update,
    delete: mocks.del,
    collection: (sub: string) => buildCollection(`${path}/${sub}`),
  };
}

function buildLegacyCollection(): Record<string, unknown> {
  return {
    doc: (_id?: string) => ({
      get: mocks.get,
      set: mocks.set,
      update: mocks.update,
      delete: mocks.del,
      collection: buildLegacyCollection,
    }),
    orderBy: mocks.orderBy,
    limit: mocks.limit,
    startAfter: mocks.startAfter,
    where: mocks.where,
    get: mocks.collectionGet,
  };
}

/** Returns a mock Firestore db object. Use inside jest.mock factory. */
export function mockDbFactory(): Record<string, unknown> {
  return {
    collection: (name: string) => (
      name.includes('/') ? buildLegacyCollection() : buildCollection(name)
    ),
    batch: () => ({
      set: mocks.batchSet,
      delete: mocks.batchDelete,
      commit: mocks.batchCommit,
    }),
  };
}

/** Firestore document snapshot returned by doc().get(). */
export function docSnapshot(
  id: string,
  data: Record<string, unknown> | null
): { exists: boolean; id: string; data: () => Record<string, unknown> | undefined } {
  return {
    exists: data !== null,
    id,
    data: () => data ?? undefined,
  };
}

/** Firestore query snapshot returned by collection().get(). */
export function querySnapshot(
  docs: Array<{ id: string; data: Record<string, unknown> }>
): { docs: Array<{ id: string; data: () => Record<string, unknown> }> } {
  return {
    docs: docs.map((d) => ({
      id: d.id,
      data: () => d.data,
    })),
  };
}

const ALL_PERMISSIONS = ['read', 'write', 'deploy', 'rollback', 'admin'] as const;

/** Default owner uid used by `seedSiteOwner` / `apiKeyAuth`. */
export const SITE_OWNER = 'user-1';

/** Seed `sites/{siteId}.owner`. Clears the map so scenarios can't inherit. */
export function seedSiteOwner(siteId: string, owner: string = SITE_OWNER): void {
  mocks.siteDocs.clear();
  mocks.siteDocs.set(siteId, { owner });
}

/** `ResolvedAuth` with wildcard api-key scopes, so scope never answers the request. */
export function apiKeyAuth(userId = SITE_OWNER): {
  userId: string;
  keyContext: Record<string, unknown>;
} {
  return {
    userId,
    keyContext: {
      keyId: 'key-billing-test',
      environment: 'live',
      expiresAt: Date.now() + 60_000,
      isLegacy: false,
      scopes: ['site', 'roost', 'machine', 'chat'].map((resource) => ({
        resource,
        id: '*',
        permissions: [...ALL_PERMISSIONS],
      })),
    },
  };
}
