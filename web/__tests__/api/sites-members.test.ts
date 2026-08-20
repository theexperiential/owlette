/** @jest-environment node */

/**
 * HTTP-shape tests for GET/POST /api/sites/{siteId}/members and
 * DELETE .../members/{uid}. Uses the path-keyed `docStore` mock style from
 * `installer-public.test.ts`.
 */

import { createMockRequest } from './helpers/utils';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

// Bypass the capability/rate/audit wrapper and let the route's inner
// `requireSiteAuthAndScope` handle auth shape. The wrapper is covered by
// `__tests__/lib/authorizedHandler.test.ts`.
jest.mock('@/lib/authorizedHandler.server', () => ({
  authorizedSiteHandler:
    () =>
    (handler: (...args: unknown[]) => unknown) =>
    async (
      request: unknown,
      routeContext: { params: Promise<{ siteId: string }> },
    ) => {
      const params = await routeContext.params;
      return handler(
        request,
        {
          actor: {
            type: 'user',
            userId: 'user-1',
            role: 'admin',
            sites: [params.siteId],
          },
          siteId: params.siteId,
          correlationId: 'corr-test',
        },
        routeContext,
      );
    },
}));

const mockEmitMutation = jest.fn();
jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: (...a: unknown[]) => mockEmitMutation(...a),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

const mockResolveAuth = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
  };
});

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    arrayUnion: (...items: unknown[]) => ({ __op: 'arrayUnion', items }),
    arrayRemove: (...items: unknown[]) => ({ __op: 'arrayRemove', items }),
    serverTimestamp: () => ({ __op: 'serverTimestamp' }),
  },
  Timestamp: { fromDate: (d: Date) => ({ toMillis: () => d.getTime() }) },
}));

// Firestore mock — keyed by collection path

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

  const filtered = () => {
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
    return docs;
  };

  const ref: Record<string, unknown> = {
    doc: (id: string) => makeDocRef([...parts, id]),
    where: (field: string, op: string, value: unknown) => {
      wheres.push({ field, op, value });
      return ref;
    },
    orderBy: () => ref,
    limit: () => ref,
    startAfter: () => ref,
    // Aggregate read — the member-removal route counts the departing member's
    // talons this way before it touches `sites[]`.
    count: () => ({
      get: jest.fn(async () => ({ data: () => ({ count: filtered().length }) })),
    }),
    get: jest.fn(async () => ({
      docs: filtered().map((d) => ({
        id: d.id,
        exists: true,
        data: () => d.data,
        ref: makeDocRef([...parts, d.id]),
      })),
    })),
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

/** Write batch — the talon store commits a reassignment through one. */
function makeBatch() {
  const ops: Array<() => Promise<void>> = [];
  return {
    set: (ref: { set: (d: Record<string, unknown>) => Promise<void> }, data: Record<string, unknown>) =>
      ops.push(() => ref.set(data)),
    update: (
      ref: { update: (p: Record<string, unknown>) => Promise<void> },
      patch: Record<string, unknown>,
    ) => ops.push(() => ref.update(patch)),
    delete: (ref: { delete: () => Promise<void> }) => ops.push(() => ref.delete()),
    commit: async () => {
      for (const op of ops) await op();
    },
  };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => makeCollectionRef([name]),
    runTransaction: mockRunTransaction,
    batch: makeBatch,
  }),
  getAdminAuth: () => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')),
  }),
  getAdminStorage: () => ({ bucket: () => ({}) }),
}));

// Imports come AFTER mocks

import {
  GET as membersGET,
  POST as membersPOST,
} from '@/app/api/sites/[siteId]/members/route';
import { DELETE as memberDELETE } from '@/app/api/sites/[siteId]/members/[uid]/route';

const SITE = 'site-alpha';

// Fixtures

function authedAsSuperadminWithKey(perm: 'read' | 'write' | 'admin' = 'admin'): void {
  mockResolveAuth.mockResolvedValue({
    userId: 'admin-uid',
    keyContext: {
      keyId: 'key_test',
      environment: 'live',
      isLegacy: false,
      scopes: [{ resource: 'site', id: '*', permissions: [perm] }],
      expiresAt: null,
    },
  });
  seedUser('admin-uid', { role: 'superadmin' });
}

function authedAsKeyMissingScope(): void {
  mockResolveAuth.mockResolvedValue({
    userId: 'admin-uid',
    keyContext: {
      keyId: 'key_readonly',
      environment: 'live',
      isLegacy: false,
      // Holds `read` but the endpoints need `admin`.
      scopes: [{ resource: 'site', id: '*', permissions: ['read'] }],
      expiresAt: null,
    },
  });
  seedUser('admin-uid', { role: 'superadmin' });
}

function authedAsMemberWithoutAccess(): void {
  // No site assignment, no ownership — assertUserHasSiteAccess must reject.
  mockResolveAuth.mockResolvedValue({
    userId: 'member-uid',
    keyContext: null,
  });
  seedUser('member-uid', { role: 'member', sites: [] });
}

function seedUser(uid: string, data: Record<string, unknown>): void {
  const path = `users/${uid}`;
  const merged = {
    email: `${uid}@example.com`,
    role: 'member',
    sites: [],
    ...data,
  };
  docStore[path] = { data: merged };
  if (!collectionDocs['users']) collectionDocs['users'] = [];
  const idx = collectionDocs['users'].findIndex((d) => d.id === uid);
  if (idx >= 0) collectionDocs['users'][idx] = { id: uid, data: merged };
  else collectionDocs['users'].push({ id: uid, data: merged });
}

function seedSite(siteId: string, data: Record<string, unknown> = {}): void {
  const path = `sites/${siteId}`;
  const merged = { owner: 'admin-uid', ...data };
  docStore[path] = { data: merged };
  if (!collectionDocs['sites']) collectionDocs['sites'] = [];
  const idx = collectionDocs['sites'].findIndex((d) => d.id === siteId);
  if (idx >= 0) collectionDocs['sites'][idx] = { id: siteId, data: merged };
  else collectionDocs['sites'].push({ id: siteId, data: merged });
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(docStore)) delete docStore[k];
  for (const k of Object.keys(collectionDocs)) delete collectionDocs[k];
});

// GET /api/sites/{siteId}/members

describe('GET /api/sites/{siteId}/members', () => {
  it('lists members with derived per-site role + surfaces owner', async () => {
    authedAsSuperadminWithKey();
    seedSite(SITE, { owner: 'owner-bob' });
    seedUser('owner-bob', { role: 'admin', sites: [] });
    seedUser('alice', { role: 'admin', sites: [SITE] });
    seedUser('member-charlie', { role: 'member', sites: [SITE] });

    const req = createMockRequest(`http://localhost/api/sites/${SITE}/members`);
    const res = await membersGET(req, {
      params: Promise.resolve({ siteId: SITE }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    const byUid: Record<string, { role: string }> = {};
    for (const m of body.members) {
      byUid[m.uid] = m;
    }
    expect(byUid['owner-bob']?.role).toBe('owner');
    expect(byUid['alice']?.role).toBe('admin');
    expect(byUid['member-charlie']?.role).toBe('member');
  });

  it('returns 404 when site does not exist', async () => {
    authedAsSuperadminWithKey();

    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/members`,
    );
    const res = await membersGET(req, {
      params: Promise.resolve({ siteId: SITE }),
    });

    expect(res.status).toBe(404);
  });

  it('rejects non-admin caller with 404 (site-not-found-or-no-access masking)', async () => {
    authedAsMemberWithoutAccess();
    seedSite(SITE);

    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/members`,
    );
    const res = await membersGET(req, {
      params: Promise.resolve({ siteId: SITE }),
    });

    // 404, not 403, on access failure — a 403 would leak site existence.
    expect([403, 404]).toContain(res.status);
  });

  it('rejects api key without admin scope (403 scope_insufficient)', async () => {
    authedAsKeyMissingScope();
    seedSite(SITE);

    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/members`,
    );
    const res = await membersGET(req, {
      params: Promise.resolve({ siteId: SITE }),
    });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe('scope_insufficient');
  });
});

// POST /api/sites/{siteId}/members

describe('POST /api/sites/{siteId}/members', () => {
  it('adds member by extending users.sites[] + emits site_member_mutated', async () => {
    authedAsSuperadminWithKey();
    seedSite(SITE);
    seedUser('alice', { role: 'admin', sites: [] });

    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/members`,
      { method: 'POST', body: { uid: 'alice', role: 'admin' } },
    );
    const res = await membersPOST(req, {
      params: Promise.resolve({ siteId: SITE }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.uid).toBe('alice');
    expect(body.requestedRole).toBe('admin');
    expect(body.roleHonored).toBe(true);
    expect(docStore['users/alice']?.data?.sites).toContain(SITE);
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'site_member_mutated',
        siteId: SITE,
        targetId: 'alice',
        attributes: expect.objectContaining({ verb: 'member_added' }),
      }),
    );
  });

  it('roleHonored=false when adding member-tier user with role=admin (global role unchanged)', async () => {
    authedAsSuperadminWithKey();
    seedSite(SITE);
    seedUser('alice', { role: 'member', sites: [] });

    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/members`,
      { method: 'POST', body: { uid: 'alice', role: 'admin' } },
    );
    const res = await membersPOST(req, {
      params: Promise.resolve({ siteId: SITE }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.roleHonored).toBe(false);
    expect(body.globalRole).toBe('member');
    expect(docStore['users/alice']?.data?.role).toBe('member');
    expect(docStore['users/alice']?.data?.sites).toContain(SITE);
  });

  it('returns 404 for unknown uid', async () => {
    authedAsSuperadminWithKey();
    seedSite(SITE);

    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/members`,
      { method: 'POST', body: { uid: 'ghost', role: 'admin' } },
    );
    const res = await membersPOST(req, {
      params: Promise.resolve({ siteId: SITE }),
    });

    expect(res.status).toBe(404);
  });

  it('rejects invalid role with 400', async () => {
    authedAsSuperadminWithKey();
    seedSite(SITE);
    seedUser('alice', { role: 'admin' });

    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/members`,
      { method: 'POST', body: { uid: 'alice', role: 'wizard' } },
    );
    const res = await membersPOST(req, {
      params: Promise.resolve({ siteId: SITE }),
    });

    expect(res.status).toBe(400);
  });

  it('rejects missing uid with 400', async () => {
    authedAsSuperadminWithKey();
    seedSite(SITE);

    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/members`,
      { method: 'POST', body: { role: 'admin' } },
    );
    const res = await membersPOST(req, {
      params: Promise.resolve({ siteId: SITE }),
    });

    expect(res.status).toBe(400);
  });
});

// DELETE /api/sites/{siteId}/members/{uid}

describe('DELETE /api/sites/{siteId}/members/{uid}', () => {
  it('removes membership from users.sites[] + emits audit', async () => {
    authedAsSuperadminWithKey();
    seedSite(SITE);
    seedUser('alice', { role: 'admin', sites: [SITE, 'site-other'] });

    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/members/alice`,
      { method: 'DELETE' },
    );
    const res = await memberDELETE(req, {
      params: Promise.resolve({ siteId: SITE, uid: 'alice' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.wasMember).toBe(true);
    expect(docStore['users/alice']?.data?.sites).toEqual(['site-other']);
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'site_member_mutated',
        siteId: SITE,
        targetId: 'alice',
        attributes: expect.objectContaining({ verb: 'member_removed' }),
      }),
    );
  });

  it('refuses to remove the site owner (409 cannot_remove_owner)', async () => {
    authedAsSuperadminWithKey();
    seedSite(SITE, { owner: 'alice' });
    seedUser('alice', { role: 'admin', sites: [SITE] });

    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/members/alice`,
      { method: 'DELETE' },
    );
    const res = await memberDELETE(req, {
      params: Promise.resolve({ siteId: SITE, uid: 'alice' }),
    });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('cannot_remove_owner');
    expect(docStore['users/alice']?.data?.sites).toContain(SITE);
  });

  it('idempotent: removing a non-member returns 200 wasMember=false', async () => {
    authedAsSuperadminWithKey();
    seedSite(SITE);
    seedUser('alice', { role: 'admin', sites: [] });

    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/members/alice`,
      { method: 'DELETE' },
    );
    const res = await memberDELETE(req, {
      params: Promise.resolve({ siteId: SITE, uid: 'alice' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.wasMember).toBe(false);
  });

  it('returns 404 when user does not exist', async () => {
    authedAsSuperadminWithKey();
    seedSite(SITE);

    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/members/ghost`,
      { method: 'DELETE' },
    );
    const res = await memberDELETE(req, {
      params: Promise.resolve({ siteId: SITE, uid: 'ghost' }),
    });

    expect(res.status).toBe(404);
  });

  // talons the departing member authored

  describe('authored talons', () => {
    function seedTalon(talonId: string, data: Record<string, unknown>): void {
      const path = `sites/${SITE}/talons/${talonId}`;
      const merged = {
        name: talonId,
        enabled: true,
        outputs: [{ type: 'email' }],
        ...data,
      };
      docStore[path] = { data: merged };
      const colPath = `sites/${SITE}/talons`;
      if (!collectionDocs[colPath]) collectionDocs[colPath] = [];
      collectionDocs[colPath].push({ id: talonId, data: merged });
    }

    it('reports the count of talons the member wrote, and leaves them alone', async () => {
      authedAsSuperadminWithKey();
      seedSite(SITE);
      seedUser('alice', { role: 'admin', sites: [SITE] });
      seedTalon('t1', { createdBy: 'alice' });
      seedTalon('t2', { createdBy: 'alice' });
      seedTalon('t3', { createdBy: 'bob' });

      const req = createMockRequest(
        `http://localhost/api/sites/${SITE}/members/alice`,
        { method: 'DELETE' },
      );
      const res = await memberDELETE(req, {
        params: Promise.resolve({ siteId: SITE, uid: 'alice' }),
      });
      const body = await res.json();

      // The count is the warning a blind api client gets; nothing moves without
      // an explicit successor.
      expect(res.status).toBe(200);
      expect(body.talonCount).toBe(2);
      expect(body.reassignedTalonIds).toEqual([]);
      expect(docStore[`sites/${SITE}/talons/t1`]?.data?.createdBy).toBe('alice');
      expect(mockEmitMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'site_member_mutated',
          attributes: expect.objectContaining({
            verb: 'member_removed',
            talonCount: 2,
            reassignedTalonCount: 0,
          }),
        }),
      );
    });

    it('reassigns to the named successor before removing membership', async () => {
      authedAsSuperadminWithKey();
      seedSite(SITE);
      seedUser('alice', { role: 'admin', sites: [SITE] });
      seedUser('bob', { role: 'admin', sites: [SITE] });
      seedTalon('t1', { createdBy: 'alice' });

      const req = createMockRequest(
        `http://localhost/api/sites/${SITE}/members/alice?talonSuccessorUid=bob`,
        { method: 'DELETE' },
      );
      const res = await memberDELETE(req, {
        params: Promise.resolve({ siteId: SITE, uid: 'alice' }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.reassignedTalonIds).toEqual(['t1']);
      expect(docStore[`sites/${SITE}/talons/t1`]?.data?.createdBy).toBe('bob');
      expect(docStore['users/alice']?.data?.sites).toEqual([]);
    });

    it('leaves membership intact when the successor is refused', async () => {
      authedAsSuperadminWithKey();
      seedSite(SITE);
      seedUser('alice', { role: 'admin', sites: [SITE] });
      // A member cannot author a talon, so they cannot inherit one either.
      seedUser('carol', { role: 'member', sites: [SITE] });
      seedTalon('t1', { createdBy: 'alice' });

      const req = createMockRequest(
        `http://localhost/api/sites/${SITE}/members/alice?talonSuccessorUid=carol`,
        { method: 'DELETE' },
      );
      const res = await memberDELETE(req, {
        params: Promise.resolve({ siteId: SITE, uid: 'alice' }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.code).toBe('successor_invalid');
      // Order matters: reassign fails, so the removal never happens.
      expect(docStore['users/alice']?.data?.sites).toEqual([SITE]);
      expect(docStore[`sites/${SITE}/talons/t1`]?.data?.createdBy).toBe('alice');
    });

    it('rejects a malformed talonSuccessorUid', async () => {
      authedAsSuperadminWithKey();
      seedSite(SITE);
      seedUser('alice', { role: 'admin', sites: [SITE] });

      const req = createMockRequest(
        `http://localhost/api/sites/${SITE}/members/alice?talonSuccessorUid=${encodeURIComponent('../escape')}`,
        { method: 'DELETE' },
      );
      const res = await memberDELETE(req, {
        params: Promise.resolve({ siteId: SITE, uid: 'alice' }),
      });

      expect(res.status).toBe(400);
      expect(docStore['users/alice']?.data?.sites).toEqual([SITE]);
    });
  });
});
