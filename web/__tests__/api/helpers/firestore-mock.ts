/**
 * Shared Firestore Mock for API Route Handler Tests
 *
 * Provides mock objects and data factories to eliminate boilerplate
 * duplication across admin API test files.
 *
 * IMPORTANT: jest.mock() calls must be at the top level of each test file
 * (Jest hoists them). This helper provides the shared mock objects that
 * those calls reference — it does NOT call jest.mock() itself.
 *
 * Usage (in each test file):
 *
 *   import { mocks, mockDbFactory, docSnapshot, querySnapshot } from '../helpers/firestore-mock';
 *
 *   // These jest.mock() calls MUST be at the top level (hoisted by Jest)
 *   jest.mock('@/lib/withRateLimit', () => ({ withRateLimit: (h: any) => h }));
 *   jest.mock('@/lib/logger', () => ({
 *     default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
 *     __esModule: true,
 *   }));
 *   jest.mock('@/lib/apiHelpers.server', () => ({
 *     requireAdminOrIdToken: (...a: any[]) => mocks.requireAdmin(...a),
 *     getRouteParam: jest.fn((req: any, idx: number) => {
 *       const s = new URL(req.url).pathname.split('/').filter(Boolean);
 *       return s[idx];
 *     }),
 *   }));
 *   jest.mock('@/lib/firebase-admin', () => ({ getAdminDb: () => mockDbFactory() }));
 *
 *   import { GET, POST } from '@/app/api/...';
 */

/* -------------------------------------------------------------------------- */
/*  Mock objects — shared across all test files                               */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/*  DB factory — returns a recursive collection/doc tree                      */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/*  Mock data factories                                                       */
/* -------------------------------------------------------------------------- */

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
