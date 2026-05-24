/** @jest-environment node */

/**
 * Public users-api — http-shape tests for `GET /api/users/deletions`.
 *
 * Reads user-deletion events out of the platform audit log
 * (`global/audit_log/entries`). Mirrors the harness style used by
 * `users.test.ts` — path-keyed `docStore` + `collectionDocs`, mocked
 * `resolveAuth`, real `requirePlatformAuthAndScope`/`requireScope`
 * underneath so superadmin + scope gating is exercised end-to-end.
 *
 * The fake `entries` collection honors the `capability in [...]` filter and
 * `orderBy('timestamp','desc')`, with timestamps stored as Firestore-style
 * objects exposing `.toDate()`.
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
    collection: (sub: string) => makeCollectionRef([...parts, sub]),
  };
}

interface WhereClause {
  field: string;
  op: string;
  value: unknown;
}

function makeCollectionRef(parts: string[]): unknown {
  const path = pathFor(parts);
  const wheres: WhereClause[] = [];
  let _orderBy: { field: string; dir: string } | null = null;
  let _limit = 1000;

  const ref: Record<string, unknown> = {
    doc: (id: string) => makeDocRef([...parts, id]),
    where: (field: string, op: string, value: unknown) => {
      wheres.push({ field, op, value });
      return ref;
    },
    orderBy: (field: string, dir = 'asc') => {
      _orderBy = { field, dir };
      return ref;
    },
    limit: (n: number) => {
      _limit = n;
      return ref;
    },
    get: jest.fn(async () => {
      let docs = (collectionDocs[path] || []).slice();
      for (const w of wheres) {
        if (w.op === '==') {
          docs = docs.filter((d) => d.data[w.field] === w.value);
        } else if (w.op === 'in') {
          const set = Array.isArray(w.value) ? w.value : [];
          docs = docs.filter((d) => set.includes(d.data[w.field]));
        } else if (w.op === 'array-contains') {
          docs = docs.filter((d) => {
            const arr = d.data[w.field];
            return Array.isArray(arr) && arr.includes(w.value);
          });
        }
      }
      if (_orderBy) {
        const f = _orderBy.field;
        docs.sort((a, b) => {
          // Audit timestamps are Firestore-style objects exposing toDate();
          // sort on their epoch-millis. Fall back to raw comparison otherwise.
          const av = sortKey(a.data[f]);
          const bv = sortKey(b.data[f]);
          if (av === bv) return 0;
          return _orderBy!.dir === 'desc' ? (av > bv ? -1 : 1) : av > bv ? 1 : -1;
        });
      }
      const sliced = docs.slice(0, _limit);
      return {
        docs: sliced.map((d) => ({
          id: d.id,
          exists: true,
          data: () => d.data,
        })),
      };
    }),
  };
  return ref;
}

function sortKey(value: unknown): number | string {
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { toDate?: () => Date }).toDate === 'function'
  ) {
    return (value as { toDate: () => Date }).toDate().getTime();
  }
  return value as number | string;
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => makeCollectionRef([name]),
  }),
  getAdminAuth: () => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')),
  }),
  getAdminStorage: () => ({ bucket: () => ({}) }),
}));

/* -------------------------------------------------------------------------- */
/*  Imports come AFTER mocks                                                  */
/* -------------------------------------------------------------------------- */

import { GET } from '@/app/api/users/deletions/route';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const ENTRIES_PATH = 'global/audit_log/entries';

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
  docStore[`users/${uid}`] = { data };
}

/** Seed an audit entry. `tsMillis` builds a Firestore-style timestamp. */
function seedAuditEntry(
  id: string,
  data: Record<string, unknown> & { tsMillis?: number },
): void {
  const { tsMillis, ...rest } = data;
  const entry: Record<string, unknown> = { ...rest };
  if (tsMillis !== undefined) {
    entry.timestamp = { toDate: () => new Date(tsMillis) };
  }
  if (!collectionDocs[ENTRIES_PATH]) collectionDocs[ENTRIES_PATH] = [];
  collectionDocs[ENTRIES_PATH].push({ id, data: entry });
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(docStore)) delete docStore[k];
  for (const k of Object.keys(collectionDocs)) delete collectionDocs[k];
});

/* ========================================================================== */
/*  GET /api/users/deletions                                                  */
/* ========================================================================== */

describe('GET /api/users/deletions', () => {
  it('returns deletion rows newest-first for a superadmin', async () => {
    authedAsSuperadminWithKey();
    seedAuditEntry('e-old', {
      capability: 'USER_SELF_DELETE',
      outcome: 'allow',
      actor: { userId: 'alice' },
      target: { kind: 'user', id: 'alice' },
      metadata: { deletedCounts: { sites: 1 } },
      tsMillis: 1000,
    });
    seedAuditEntry('e-new', {
      capability: 'USER_DELETE',
      outcome: 'allow',
      actor: { userId: 'user-superadmin' },
      target: { kind: 'user', id: 'bob' },
      metadata: { deletedCounts: { sites: 3 } },
      tsMillis: 5000,
    });
    seedAuditEntry('e-mid', {
      capability: 'USER_SELF_DELETE',
      outcome: 'deny',
      actor: { userId: 'carol' },
      target: { kind: 'user', id: 'carol' },
      denyReason: 'needs_successor',
      tsMillis: 3000,
    });

    const req = createMockRequest('http://localhost/api/users/deletions');
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    const ids = body.deletions.map((d: { id: string }) => d.id);
    expect(ids).toEqual(['e-new', 'e-mid', 'e-old']);

    const newest = body.deletions[0];
    expect(newest.uid).toBe('bob');
    expect(newest.actorUid).toBe('user-superadmin');
    expect(newest.capability).toBe('USER_DELETE');
    expect(newest.outcome).toBe('allow');
    expect(newest.timestamp).toBe(new Date(5000).toISOString());
    expect(newest.counts).toEqual({ sites: 3 });
    expect(newest.denyReason).toBeNull();

    const denied = body.deletions[1];
    expect(denied.denyReason).toBe('needs_successor');
    expect(denied.counts).toBeNull();
  });

  it('rejects a non-superadmin caller with 403', async () => {
    authedAsNonSuperadminWithKey();
    seedAuditEntry('e-1', {
      capability: 'USER_DELETE',
      outcome: 'allow',
      actor: { userId: 'sa' },
      target: { kind: 'user', id: 'bob' },
      tsMillis: 1000,
    });

    const req = createMockRequest('http://localhost/api/users/deletions');
    const res = await GET(req);

    expect(res.status).toBe(403);
  });

  it('excludes non-deletion audit entries', async () => {
    authedAsSuperadminWithKey();
    seedAuditEntry('del-self', {
      capability: 'USER_SELF_DELETE',
      outcome: 'allow',
      actor: { userId: 'alice' },
      target: { kind: 'user', id: 'alice' },
      tsMillis: 2000,
    });
    seedAuditEntry('del-admin', {
      capability: 'USER_DELETE',
      outcome: 'allow',
      actor: { userId: 'sa' },
      target: { kind: 'user', id: 'bob' },
      tsMillis: 1000,
    });
    // Noise: unrelated capabilities that must NOT appear.
    seedAuditEntry('noise-role', {
      capability: 'USER_ROLE_MANAGE',
      outcome: 'allow',
      actor: { userId: 'sa' },
      target: { kind: 'user', id: 'carol' },
      tsMillis: 9000,
    });
    seedAuditEntry('noise-machine', {
      capability: 'MACHINE_REMOVE',
      outcome: 'allow',
      actor: { userId: 'sa' },
      target: { kind: 'machine', id: 'm1' },
      tsMillis: 8000,
    });

    const req = createMockRequest('http://localhost/api/users/deletions');
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    const ids = body.deletions.map((d: { id: string }) => d.id).sort();
    expect(ids).toEqual(['del-admin', 'del-self']);
    const caps = body.deletions.map((d: { capability: string }) => d.capability);
    expect(caps).not.toContain('USER_ROLE_MANAGE');
    expect(caps).not.toContain('MACHINE_REMOVE');
  });

  it('clamps a limit above 200 down to 200', async () => {
    authedAsSuperadminWithKey();
    // Seed 250 deletion entries; with limit=99999 the route must clamp to 200,
    // so the fake collection's limit() truncates the result to exactly 200.
    for (let i = 0; i < 250; i++) {
      seedAuditEntry(`e-${i}`, {
        capability: 'USER_DELETE',
        outcome: 'allow',
        actor: { userId: 'sa' },
        target: { kind: 'user', id: `u-${i}` },
        tsMillis: 1000 + i,
      });
    }

    const req = createMockRequest(
      'http://localhost/api/users/deletions?limit=99999',
    );
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.deletions).toHaveLength(200);
  });
});
