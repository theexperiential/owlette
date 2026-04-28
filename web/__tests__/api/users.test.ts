/** @jest-environment node */

/**
 * Public users-api — http-shape tests for `/api/users/*`
 * (api-sprint wave 3 track 3B).
 *
 * Covers the seven user verbs: list, detail, promote, demote, assign-sites,
 * remove-sites, soft-delete-cascade. Mirrors the call-shape style used by
 * `installer-public.test.ts` — path-keyed `docStore` + `collectionDocs`,
 * mocked `resolveAuth`, real `requirePlatformAuthAndScope`/`requireScope`
 * underneath so scope and superadmin gating is exercised end-to-end.
 */

import { createMockRequest } from './helpers/utils';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockEmitMutation = jest.fn();
jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: (...a: unknown[]) => mockEmitMutation(...a),
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
/*  firebase-admin/firestore mock for FieldValue                              */
/* -------------------------------------------------------------------------- */

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    arrayUnion: (...items: unknown[]) => ({ __op: 'arrayUnion', items }),
    arrayRemove: (...items: unknown[]) => ({ __op: 'arrayRemove', items }),
    serverTimestamp: () => ({ __op: 'serverTimestamp' }),
  },
  Timestamp: { fromDate: (d: Date) => ({ toMillis: () => d.getTime() }) },
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

function applyFieldOps(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && '__op' in (value as object)) {
      const op = (value as { __op: string }).__op;
      const items = (value as { items?: unknown[] }).items ?? [];
      const current = Array.isArray(next[key])
        ? (next[key] as unknown[]).slice()
        : [];
      if (op === 'arrayUnion') {
        for (const it of items) {
          if (!current.includes(it)) current.push(it);
        }
        next[key] = current;
      } else if (op === 'arrayRemove') {
        next[key] = current.filter((x) => !items.includes(x));
      } else if (op === 'serverTimestamp') {
        next[key] = Date.now();
      } else {
        next[key] = value;
      }
    } else {
      next[key] = value;
    }
  }
  return next;
}

function syncCollection(parts: string[], docId: string, data: Record<string, unknown> | null): void {
  // Mirror writes into `collectionDocs` so list/where queries see them.
  const colPath = pathFor(parts.slice(0, -1));
  if (!collectionDocs[colPath]) collectionDocs[colPath] = [];
  const idx = collectionDocs[colPath].findIndex((d) => d.id === docId);
  if (data === null) {
    if (idx >= 0) collectionDocs[colPath].splice(idx, 1);
  } else {
    if (idx >= 0) collectionDocs[colPath][idx] = { id: docId, data };
    else collectionDocs[colPath].push({ id: docId, data });
  }
}

function makeDocRef(parts: string[]): unknown {
  const path = pathFor(parts);
  const docId = parts[parts.length - 1];
  const ref: Record<string, unknown> = {
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
    set: jest.fn(async (data: Record<string, unknown>) => {
      docStore[path] = { data };
      syncCollection(parts, docId, data);
    }),
    update: jest.fn(async (patch: Record<string, unknown>) => {
      const existing = docStore[path]?.data ?? {};
      const next = applyFieldOps(existing, patch);
      docStore[path] = { data: next };
      syncCollection(parts, docId, next);
    }),
    delete: jest.fn(async () => {
      docStore[path] = { data: null };
      syncCollection(parts, docId, null);
    }),
    collection: (sub: string) => makeCollectionRef([...parts, sub]),
  };
  return ref;
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
  let _startAfterId: string | null = null;

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
    startAfter: (snap: { id: string }) => {
      _startAfterId = snap.id;
      return ref;
    },
    get: jest.fn(async () => {
      let docs = (collectionDocs[path] || []).slice();
      for (const w of wheres) {
        if (w.op === '==') {
          docs = docs.filter((d) => d.data[w.field] === w.value);
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
          // Treat '__name__' as the doc id.
          const av = f === '__name__' ? a.id : (a.data[f] as number | string);
          const bv = f === '__name__' ? b.id : (b.data[f] as number | string);
          if (av === bv) return 0;
          return _orderBy!.dir === 'desc' ? (av > bv ? -1 : 1) : av > bv ? 1 : -1;
        });
      }
      let startIdx = 0;
      if (_startAfterId) {
        const idx = docs.findIndex((d) => d.id === _startAfterId);
        startIdx = idx >= 0 ? idx + 1 : 0;
      }
      const sliced = docs.slice(startIdx, startIdx + _limit);
      return {
        docs: sliced.map((d) => ({
          id: d.id,
          exists: true,
          data: () => d.data,
          ref: makeDocRef([...parts, d.id]),
        })),
      };
    }),
  };
  return ref;
}

const mockRunTransaction = jest.fn(
  async (cb: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
    const tx = {
      get: async (refOrQuery: { get: () => Promise<unknown> }) =>
        refOrQuery.get(),
      set: (
        ref: { set: (data: Record<string, unknown>) => Promise<void> },
        data: Record<string, unknown>,
      ) => ref.set(data),
      update: (
        ref: { update: (patch: Record<string, unknown>) => Promise<void> },
        patch: Record<string, unknown>,
      ) => ref.update(patch),
    };
    return cb(tx);
  },
);

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => makeCollectionRef([name]),
    runTransaction: mockRunTransaction,
  }),
  getAdminAuth: () => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')),
  }),
  getAdminStorage: () => ({ bucket: () => ({}) }),
}));

/* -------------------------------------------------------------------------- */
/*  Imports come AFTER mocks                                                  */
/* -------------------------------------------------------------------------- */

import { GET as listGET } from '@/app/api/users/route';
import { GET as detailGET, DELETE as detailDELETE } from '@/app/api/users/[uid]/route';
import { POST as promotePOST } from '@/app/api/users/[uid]/promote/route';
import { POST as demotePOST } from '@/app/api/users/[uid]/demote/route';
import { POST as assignSitesPOST } from '@/app/api/users/[uid]/assign-sites/route';
import { POST as removeSitesPOST } from '@/app/api/users/[uid]/remove-sites/route';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

function authedAsSuperadminWithKey(
  perm: 'read' | 'write' | 'admin',
  userId = 'user-superadmin',
): void {
  mockResolveAuth.mockResolvedValue({
    userId,
    keyContext: {
      keyId: 'key_test',
      environment: 'live',
      isLegacy: false,
      scopes: [{ resource: 'user', id: '*', permissions: [perm] }],
      expiresAt: null,
    },
  });
  seedUser(userId, { role: 'superadmin', email: 'sa@example.com' });
}

function authedAsNonSuperadminWithKey(perm: 'read' | 'write' | 'admin'): void {
  mockResolveAuth.mockResolvedValue({
    userId: 'user-regular',
    keyContext: {
      keyId: 'key_test',
      environment: 'live',
      isLegacy: false,
      scopes: [{ resource: 'user', id: '*', permissions: [perm] }],
      expiresAt: null,
    },
  });
  seedUser('user-regular', { role: 'admin', email: 'admin@example.com' });
}

function authedAsKeyMissingScope(perm: 'read' | 'write' | 'admin'): void {
  mockResolveAuth.mockResolvedValue({
    userId: 'user-superadmin',
    keyContext: {
      keyId: 'key_readonly',
      environment: 'live',
      isLegacy: false,
      scopes: [{ resource: 'user', id: '*', permissions: [perm] }],
      expiresAt: null,
    },
  });
  seedUser('user-superadmin', { role: 'superadmin' });
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

function seedSite(siteId: string, data: Record<string, unknown> = {}): void {
  const path = `sites/${siteId}`;
  docStore[path] = { data: { owner: 'user-superadmin', ...data } };
  if (!collectionDocs['sites']) collectionDocs['sites'] = [];
  const idx = collectionDocs['sites'].findIndex((d) => d.id === siteId);
  if (idx >= 0) {
    collectionDocs['sites'][idx] = { id: siteId, data: docStore[path].data! };
  } else {
    collectionDocs['sites'].push({
      id: siteId,
      data: docStore[path].data!,
    });
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(docStore)) delete docStore[k];
  for (const k of Object.keys(collectionDocs)) delete collectionDocs[k];
});

/* ========================================================================== */
/*  GET /api/users                                                            */
/* ========================================================================== */

describe('GET /api/users', () => {
  it('lists active users (excludes soft-deleted by default)', async () => {
    authedAsSuperadminWithKey('read');
    seedUser('alice', { role: 'admin' });
    seedUser('bob', { role: 'member' });
    seedUser('zombie', { role: 'member', deletedAt: 1234 });

    const req = createMockRequest('http://localhost/api/users');
    const res = await listGET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    const ids = body.users.map((u: { uid: string }) => u.uid).sort();
    expect(ids).toEqual(['alice', 'bob', 'user-superadmin']);
  });

  it('includeDeleted=true surfaces soft-deleted users', async () => {
    authedAsSuperadminWithKey('read');
    seedUser('alice', { role: 'admin' });
    seedUser('zombie', { role: 'member', deletedAt: 1234 });

    const req = createMockRequest(
      'http://localhost/api/users?includeDeleted=true',
    );
    const res = await listGET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    const ids = body.users.map((u: { uid: string }) => u.uid).sort();
    expect(ids).toContain('zombie');
  });

  it('role filter narrows results', async () => {
    authedAsSuperadminWithKey('read');
    seedUser('alice', { role: 'admin' });
    seedUser('bob', { role: 'member' });

    const req = createMockRequest('http://localhost/api/users?role=admin');
    const res = await listGET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    const ids = body.users.map((u: { uid: string }) => u.uid);
    expect(ids).toContain('alice');
    expect(ids).not.toContain('bob');
  });

  it('rejects invalid role filter with 400', async () => {
    authedAsSuperadminWithKey('read');

    const req = createMockRequest('http://localhost/api/users?role=wizard');
    const res = await listGET(req);

    expect(res.status).toBe(400);
  });

  it('site filter returns only users with that siteId in their sites[]', async () => {
    authedAsSuperadminWithKey('read');
    seedUser('alice', { role: 'admin', sites: ['site-a', 'site-b'] });
    seedUser('bob', { role: 'member', sites: ['site-c'] });

    const req = createMockRequest('http://localhost/api/users?site=site-a');
    const res = await listGET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    const ids = body.users.map((u: { uid: string }) => u.uid);
    expect(ids).toContain('alice');
    expect(ids).not.toContain('bob');
  });

  it('rejects non-superadmin api key with 403 forbidden', async () => {
    authedAsNonSuperadminWithKey('read');

    const req = createMockRequest('http://localhost/api/users');
    const res = await listGET(req);

    expect(res.status).toBe(403);
  });

  it('paginates: emits page_token when more results exist', async () => {
    authedAsSuperadminWithKey('read');
    for (let i = 0; i < 5; i++) {
      seedUser(`u-${i}`, { role: 'member' });
    }

    const req = createMockRequest('http://localhost/api/users?page_size=2');
    const res = await listGET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.users).toHaveLength(2);
    expect(body.next_page_token).toBe(body.nextPageToken);
    expect(body.nextPageToken).not.toBe('');
  });

  it('uses the last emitted user as page token when deleted users are skipped', async () => {
    authedAsSuperadminWithKey('read');
    seedUser('a-active', { role: 'member' });
    seedUser('b-deleted', { role: 'member', deletedAt: 1234 });
    seedUser('c-active', { role: 'member' });

    const req = createMockRequest('http://localhost/api/users?page_size=1');
    const res = await listGET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.users).toHaveLength(1);
    expect(body.users[0].uid).toBe('a-active');
    expect(body.next_page_token).toBe('a-active');
  });
});

/* ========================================================================== */
/*  GET /api/users/{uid}                                                      */
/* ========================================================================== */

describe('GET /api/users/{uid}', () => {
  it('returns user detail incl. sites[]', async () => {
    authedAsSuperadminWithKey('read');
    seedUser('alice', { role: 'admin', sites: ['site-a'] });

    const req = createMockRequest('http://localhost/api/users/alice');
    const res = await detailGET(req, {
      params: Promise.resolve({ uid: 'alice' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.uid).toBe('alice');
    expect(body.role).toBe('admin');
    expect(body.sites).toEqual(['site-a']);
  });

  it('returns 404 for unknown user', async () => {
    authedAsSuperadminWithKey('read');

    const req = createMockRequest('http://localhost/api/users/nonexistent');
    const res = await detailGET(req, {
      params: Promise.resolve({ uid: 'nonexistent' }),
    });

    expect(res.status).toBe(404);
  });

  it('rejects non-superadmin even with user=*:read scope', async () => {
    authedAsNonSuperadminWithKey('read');
    seedUser('alice', { role: 'member' });

    const req = createMockRequest('http://localhost/api/users/alice');
    const res = await detailGET(req, {
      params: Promise.resolve({ uid: 'alice' }),
    });

    expect(res.status).toBe(403);
  });
});

/* ========================================================================== */
/*  POST /api/users/{uid}/promote                                             */
/* ========================================================================== */

describe('POST /api/users/{uid}/promote', () => {
  it('promotes a member to admin atomically + emits audit', async () => {
    authedAsSuperadminWithKey('write');
    seedUser('alice', { role: 'member' });

    const req = createMockRequest(
      'http://localhost/api/users/alice/promote',
      { method: 'POST', body: { role: 'admin' } },
    );
    const res = await promotePOST(req, {
      params: Promise.resolve({ uid: 'alice' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.role).toBe('admin');
    expect(body.previousRole).toBe('member');
    expect(body.changed).toBe(true);
    expect(docStore['users/alice']?.data?.role).toBe('admin');
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'user_mutated',
        targetId: 'alice',
        attributes: expect.objectContaining({
          verb: 'promoted',
          from: 'member',
          to: 'admin',
        }),
      }),
    );
  });

  it('rejects invalid role with 400', async () => {
    authedAsSuperadminWithKey('write');
    seedUser('alice', { role: 'member' });

    const req = createMockRequest(
      'http://localhost/api/users/alice/promote',
      { method: 'POST', body: { role: 'wizard' } },
    );
    const res = await promotePOST(req, {
      params: Promise.resolve({ uid: 'alice' }),
    });

    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown uid', async () => {
    authedAsSuperadminWithKey('write');

    const req = createMockRequest(
      'http://localhost/api/users/ghost/promote',
      { method: 'POST', body: { role: 'admin' } },
    );
    const res = await promotePOST(req, {
      params: Promise.resolve({ uid: 'ghost' }),
    });

    expect(res.status).toBe(404);
  });

  it('noop when user is already at requested role', async () => {
    authedAsSuperadminWithKey('write');
    seedUser('alice', { role: 'admin' });

    const req = createMockRequest(
      'http://localhost/api/users/alice/promote',
      { method: 'POST', body: { role: 'admin' } },
    );
    const res = await promotePOST(req, {
      params: Promise.resolve({ uid: 'alice' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.changed).toBe(false);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('rejects api key without write scope (403 scope_insufficient)', async () => {
    authedAsKeyMissingScope('read');
    seedUser('alice', { role: 'member' });

    const req = createMockRequest(
      'http://localhost/api/users/alice/promote',
      { method: 'POST', body: { role: 'admin' } },
    );
    const res = await promotePOST(req, {
      params: Promise.resolve({ uid: 'alice' }),
    });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe('scope_insufficient');
  });
});

/* ========================================================================== */
/*  POST /api/users/{uid}/demote                                              */
/* ========================================================================== */

describe('POST /api/users/{uid}/demote', () => {
  it('demotes admin to member', async () => {
    authedAsSuperadminWithKey('write');
    seedUser('alice', { role: 'admin' });
    // Need at least 1 superadmin for the count check (auth fixture seeds one).

    const req = createMockRequest(
      'http://localhost/api/users/alice/demote',
      { method: 'POST', body: {} },
    );
    const res = await demotePOST(req, {
      params: Promise.resolve({ uid: 'alice' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.role).toBe('member');
    expect(body.previousRole).toBe('admin');
    expect(docStore['users/alice']?.data?.role).toBe('member');
  });

  it('refuses to demote the last active superadmin (409 last_superadmin)', async () => {
    authedAsSuperadminWithKey('write');
    // Auth fixture seeded `user-superadmin` as the only superadmin.
    // Demoting them should trip the floor.

    const req = createMockRequest(
      'http://localhost/api/users/user-superadmin/demote',
      { method: 'POST', body: {} },
    );
    const res = await demotePOST(req, {
      params: Promise.resolve({ uid: 'user-superadmin' }),
    });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('last_superadmin');
    expect(docStore['users/user-superadmin']?.data?.role).toBe('superadmin');
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('demotes a superadmin when at least one other active superadmin remains', async () => {
    authedAsSuperadminWithKey('write');
    seedUser('alice', { role: 'superadmin' });

    const req = createMockRequest(
      'http://localhost/api/users/alice/demote',
      { method: 'POST', body: {} },
    );
    const res = await demotePOST(req, {
      params: Promise.resolve({ uid: 'alice' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.role).toBe('member');
    expect(body.previousRole).toBe('superadmin');
  });

  it('does not count soft-deleted superadmins toward the floor', async () => {
    authedAsSuperadminWithKey('write');
    // Auth fixture seeded user-superadmin; we add a soft-deleted superadmin
    // but it shouldn't satisfy the floor → demoting alice should still be ok
    // because alice is admin, but trying to demote user-superadmin should
    // still trip the floor.
    seedUser('zombie-sa', { role: 'superadmin', deletedAt: 1234 });

    const req = createMockRequest(
      'http://localhost/api/users/user-superadmin/demote',
      { method: 'POST', body: {} },
    );
    const res = await demotePOST(req, {
      params: Promise.resolve({ uid: 'user-superadmin' }),
    });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('last_superadmin');
  });

  it('returns 404 for unknown uid', async () => {
    authedAsSuperadminWithKey('write');

    const req = createMockRequest(
      'http://localhost/api/users/ghost/demote',
      { method: 'POST', body: {} },
    );
    const res = await demotePOST(req, {
      params: Promise.resolve({ uid: 'ghost' }),
    });

    expect(res.status).toBe(404);
  });
});

/* ========================================================================== */
/*  POST /api/users/{uid}/assign-sites                                        */
/* ========================================================================== */

describe('POST /api/users/{uid}/assign-sites', () => {
  it('adds siteIds via arrayUnion + emits audit', async () => {
    authedAsSuperadminWithKey('write');
    seedUser('alice', { role: 'member', sites: [] });
    seedSite('site-a');
    seedSite('site-b');

    const req = createMockRequest(
      'http://localhost/api/users/alice/assign-sites',
      { method: 'POST', body: { siteIds: ['site-a', 'site-b'] } },
    );
    const res = await assignSitesPOST(req, {
      params: Promise.resolve({ uid: 'alice' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.assignedSiteIds).toEqual(['site-a', 'site-b']);
    expect(docStore['users/alice']?.data?.sites).toEqual(['site-a', 'site-b']);
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'user_mutated',
        attributes: expect.objectContaining({ verb: 'sites_assigned' }),
      }),
    );
  });

  it('rejects when any siteId is unknown (400 unknown_site, no partial mutation)', async () => {
    authedAsSuperadminWithKey('write');
    seedUser('alice', { role: 'member', sites: [] });
    seedSite('site-a');
    // site-zzz intentionally unseeded

    const req = createMockRequest(
      'http://localhost/api/users/alice/assign-sites',
      { method: 'POST', body: { siteIds: ['site-a', 'site-zzz'] } },
    );
    const res = await assignSitesPOST(req, {
      params: Promise.resolve({ uid: 'alice' }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe('unknown_site');
    expect(body.unknownSites).toContain('site-zzz');
    expect(docStore['users/alice']?.data?.sites).toEqual([]);
  });

  it('rejects empty array with 400', async () => {
    authedAsSuperadminWithKey('write');
    seedUser('alice', { role: 'member' });

    const req = createMockRequest(
      'http://localhost/api/users/alice/assign-sites',
      { method: 'POST', body: { siteIds: [] } },
    );
    const res = await assignSitesPOST(req, {
      params: Promise.resolve({ uid: 'alice' }),
    });

    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown user', async () => {
    authedAsSuperadminWithKey('write');
    seedSite('site-a');

    const req = createMockRequest(
      'http://localhost/api/users/ghost/assign-sites',
      { method: 'POST', body: { siteIds: ['site-a'] } },
    );
    const res = await assignSitesPOST(req, {
      params: Promise.resolve({ uid: 'ghost' }),
    });

    expect(res.status).toBe(404);
  });
});

/* ========================================================================== */
/*  POST /api/users/{uid}/remove-sites                                        */
/* ========================================================================== */

describe('POST /api/users/{uid}/remove-sites', () => {
  it('removes siteIds via arrayRemove + emits audit', async () => {
    authedAsSuperadminWithKey('write');
    seedUser('alice', {
      role: 'admin',
      sites: ['site-a', 'site-b', 'site-c'],
    });

    const req = createMockRequest(
      'http://localhost/api/users/alice/remove-sites',
      { method: 'POST', body: { siteIds: ['site-a', 'site-b'] } },
    );
    const res = await removeSitesPOST(req, {
      params: Promise.resolve({ uid: 'alice' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.removedSiteIds).toEqual(['site-a', 'site-b']);
    expect(docStore['users/alice']?.data?.sites).toEqual(['site-c']);
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'user_mutated',
        attributes: expect.objectContaining({ verb: 'sites_removed' }),
      }),
    );
  });

  it('rejects empty siteIds array', async () => {
    authedAsSuperadminWithKey('write');
    seedUser('alice', { role: 'admin', sites: ['site-a'] });

    const req = createMockRequest(
      'http://localhost/api/users/alice/remove-sites',
      { method: 'POST', body: { siteIds: [] } },
    );
    const res = await removeSitesPOST(req, {
      params: Promise.resolve({ uid: 'alice' }),
    });

    expect(res.status).toBe(400);
  });
});

/* ========================================================================== */
/*  DELETE /api/users/{uid}                                                   */
/* ========================================================================== */

describe('DELETE /api/users/{uid}', () => {
  it('soft-deletes a user with no owned sites + revokes their keys', async () => {
    authedAsSuperadminWithKey('admin');
    seedUser('alice', { role: 'member' });
    // Seed an api-key entry so the cascade has something to revoke.
    docStore['users/alice/api_keys/key1'] = {
      data: { keyHash: 'hash1', name: 'k1' },
    };
    if (!collectionDocs['users/alice/api_keys']) {
      collectionDocs['users/alice/api_keys'] = [];
    }
    collectionDocs['users/alice/api_keys'].push({
      id: 'key1',
      data: { keyHash: 'hash1', name: 'k1' },
    });
    docStore['api_keys/hash1'] = { data: { keyId: 'key1', userId: 'alice' } };

    const req = createMockRequest('http://localhost/api/users/alice', {
      method: 'DELETE',
    });
    const res = await detailDELETE(req, {
      params: Promise.resolve({ uid: 'alice' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.alreadyDeleted).toBe(false);
    expect(body.deletedAt).toBeGreaterThan(0);
    expect(body.revokedKeyIds).toContain('key1');
    expect(docStore['users/alice']?.data?.deletedAt).toBeDefined();
    expect(docStore['users/alice/api_keys/key1']?.data?.revokedAt).toBeDefined();
    expect(docStore['api_keys/hash1']?.data?.revokedAt).toBeDefined();
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'user_mutated',
        targetId: 'alice',
        attributes: expect.objectContaining({ verb: 'soft_deleted' }),
      }),
    );
  });

  it('refuses delete when user owns sites and successorUid is missing (409 orphan_sites)', async () => {
    authedAsSuperadminWithKey('admin');
    seedUser('alice', { role: 'admin' });
    seedSite('site-orphan', { owner: 'alice' });

    const req = createMockRequest('http://localhost/api/users/alice', {
      method: 'DELETE',
    });
    const res = await detailDELETE(req, {
      params: Promise.resolve({ uid: 'alice' }),
    });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('orphan_sites');
    expect(body.ownedSites).toContain('site-orphan');
    expect(docStore['users/alice']?.data?.deletedAt).toBeUndefined();
  });

  it('transfers owned sites to successor when successorUid provided', async () => {
    authedAsSuperadminWithKey('admin');
    seedUser('alice', { role: 'admin' });
    seedUser('bob', { role: 'admin', sites: [] });
    seedSite('site-orphan', { owner: 'alice' });

    const req = createMockRequest(
      'http://localhost/api/users/alice?successorUid=bob',
      { method: 'DELETE' },
    );
    const res = await detailDELETE(req, {
      params: Promise.resolve({ uid: 'alice' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.transferredSites).toContain('site-orphan');
    expect(docStore['sites/site-orphan']?.data?.owner).toBe('bob');
    expect(docStore['users/bob']?.data?.sites).toContain('site-orphan');
    expect(docStore['users/alice']?.data?.deletedAt).toBeDefined();
  });

  it('rejects successor that is a member (400 successor_invalid not_admin)', async () => {
    authedAsSuperadminWithKey('admin');
    seedUser('alice', { role: 'admin' });
    seedUser('member-bob', { role: 'member' });
    seedSite('site-orphan', { owner: 'alice' });

    const req = createMockRequest(
      'http://localhost/api/users/alice?successorUid=member-bob',
      { method: 'DELETE' },
    );
    const res = await detailDELETE(req, {
      params: Promise.resolve({ uid: 'alice' }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe('successor_invalid');
    expect(body.reason).toBe('not_admin');
    expect(docStore['users/alice']?.data?.deletedAt).toBeUndefined();
  });

  it('idempotent: deleting an already-deleted user returns 200 alreadyDeleted=true with no re-emit', async () => {
    authedAsSuperadminWithKey('admin');
    seedUser('alice', { role: 'member', deletedAt: 4242 });

    const req = createMockRequest('http://localhost/api/users/alice', {
      method: 'DELETE',
    });
    const res = await detailDELETE(req, {
      params: Promise.resolve({ uid: 'alice' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.alreadyDeleted).toBe(true);
    expect(body.deletedAt).toBe(4242);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown uid', async () => {
    authedAsSuperadminWithKey('admin');

    const req = createMockRequest('http://localhost/api/users/ghost', {
      method: 'DELETE',
    });
    const res = await detailDELETE(req, {
      params: Promise.resolve({ uid: 'ghost' }),
    });

    expect(res.status).toBe(404);
  });

  it('rejects non-superadmin even with user=*:admin scope', async () => {
    authedAsNonSuperadminWithKey('admin');
    seedUser('alice', { role: 'member' });

    const req = createMockRequest('http://localhost/api/users/alice', {
      method: 'DELETE',
    });
    const res = await detailDELETE(req, {
      params: Promise.resolve({ uid: 'alice' }),
    });

    expect(res.status).toBe(403);
  });
});
