/** @jest-environment node */

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
  rateLimitHeaders: jest.fn(() => ({})),
}));

jest.mock('@/lib/securityConfig.server', () => ({
  securityConfig: {
    read: jest.fn(async () => ({
      capability_enforcement: true,
      rate_limit_enforcement: true,
    })),
  },
}));

jest.mock('firebase-admin/firestore', () => {
  class MockTimestamp {
    private readonly ms: number;

    constructor(ms: number) {
      this.ms = ms;
    }

    static fromDate(d: Date): MockTimestamp {
      return new MockTimestamp(d.getTime());
    }

    toMillis(): number {
      return this.ms;
    }
  }

  return {
    FieldValue: {
      serverTimestamp: () => ({ __op: 'serverTimestamp' }),
    },
    Timestamp: MockTimestamp,
  };
});

interface DocStore {
  data: Record<string, unknown> | null;
}

interface WhereClause {
  field: string;
  op: string;
  value: unknown;
}

const docStore: Record<string, DocStore> = {};
const collectionDocs: Record<string, Array<{ id: string; data: Record<string, unknown> }>> = {};
let autoId = 0;

function pathFor(parts: string[]): string {
  return parts.join('/');
}

function applyFieldOps(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && '__op' in value) {
      const op = (value as { __op: string }).__op;
      if (op === 'serverTimestamp') {
        next[key] = Date.now();
        continue;
      }
    }
    next[key] = value;
  }
  return next;
}

function syncCollection(parts: string[], docId: string, data: Record<string, unknown> | null): void {
  const colPath = pathFor(parts.slice(0, -1));
  if (!collectionDocs[colPath]) collectionDocs[colPath] = [];
  const idx = collectionDocs[colPath].findIndex((d) => d.id === docId);
  if (data === null) {
    if (idx >= 0) collectionDocs[colPath].splice(idx, 1);
  } else if (idx >= 0) {
    collectionDocs[colPath][idx] = { id: docId, data };
  } else {
    collectionDocs[colPath].push({ id: docId, data });
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
    collection: (name: string) => makeCollectionRef([...parts, name]),
  };
  return ref;
}

function makeCollectionRef(parts: string[]): unknown {
  const path = pathFor(parts);
  const wheres: WhereClause[] = [];

  const ref: Record<string, unknown> = {
    doc: (id?: string) => makeDocRef([...parts, id ?? `auto-${++autoId}`]),
    where: (field: string, op: string, value: unknown) => {
      wheres.push({ field, op, value });
      return ref;
    },
    orderBy: () => ref,
    limit: () => ref,
    startAfter: () => ref,
    get: jest.fn(async () => {
      let docs = (collectionDocs[path] || []).slice();
      for (const w of wheres) {
        docs = docs.filter((d) => {
          const fieldValue = w.field === '__name__' ? d.id : d.data[w.field];
          if (w.op === '==') return fieldValue === w.value;
          if (w.op === 'in') return Array.isArray(w.value) && w.value.includes(fieldValue);
          if (w.op === 'array-contains') {
            return Array.isArray(fieldValue) && fieldValue.includes(w.value);
          }
          return true;
        });
      }
      return {
        docs: docs.map((d) => ({
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

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => makeCollectionRef([name]),
  }),
  getAdminAuth: () => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')),
  }),
  getAdminStorage: () => ({ bucket: () => ({}) }),
}));

import { GET as sitesGET, POST as sitesPOST } from '@/app/api/sites/route';
import {
  GET as siteGET,
  PATCH as sitePATCH,
  DELETE as siteDELETE,
} from '@/app/api/sites/[siteId]/route';

type Scope = {
  resource: 'site' | 'roost' | 'machine' | 'chat' | 'user' | 'installer';
  id: string;
  permissions: string[];
};

function seedUser(uid: string, data: Record<string, unknown> = {}): void {
  const merged = {
    email: `${uid}@example.com`,
    role: 'member',
    sites: [],
    ...data,
  };
  const path = `users/${uid}`;
  docStore[path] = { data: merged };
  syncCollection(['users', uid], uid, merged);
}

function seedSite(siteId: string, data: Record<string, unknown> = {}): void {
  const merged = {
    name: siteId,
    owner: 'owner-uid',
    timezone: 'UTC',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...data,
  };
  const path = `sites/${siteId}`;
  docStore[path] = { data: merged };
  syncCollection(['sites', siteId], siteId, merged);
}

function authedSession(userId: string, role: string, sites: string[] = []): void {
  seedUser(userId, { role, sites });
  mockResolveAuth.mockResolvedValue({ userId, keyContext: null });
}

function authedKey(
  userId: string,
  role: string,
  scopes: Scope[] | null,
  options: { isLegacy?: boolean; sites?: string[] } = {},
): void {
  seedUser(userId, { role, sites: options.sites ?? [] });
  mockResolveAuth.mockResolvedValue({
    userId,
    keyContext: {
      keyId: 'key_test',
      environment: 'live',
      isLegacy: options.isLegacy === true,
      scopes,
      expiresAt: null,
    },
  });
}

function siteScope(id: string, permission: string): Scope {
  return { resource: 'site', id, permissions: [permission] };
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(docStore)) delete docStore[key];
  for (const key of Object.keys(collectionDocs)) delete collectionDocs[key];
  autoId = 0;
});

describe('GET /api/sites', () => {
  it('lists assigned and owned sites for session callers', async () => {
    authedSession('alice', 'member', ['site-b']);
    seedSite('site-a', { name: 'Alpha', owner: 'alice' });
    seedSite('site-b', { name: 'Beta', owner: 'other' });
    seedSite('site-c', { name: 'Gamma', owner: 'other' });

    const res = await sitesGET(createMockRequest('http://localhost/api/sites'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sites.map((s: { id: string }) => s.id)).toEqual(['site-a', 'site-b']);
  });

  it('limits scoped API keys to explicit site scopes', async () => {
    authedKey('admin-uid', 'superadmin', [siteScope('site-b', 'read')]);
    seedSite('site-a', { name: 'Alpha' });
    seedSite('site-b', { name: 'Beta' });

    const res = await sitesGET(createMockRequest('http://localhost/api/sites'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sites.map((s: { id: string }) => s.id)).toEqual(['site-b']);
  });

  it('does not expose all account sites to non-site-scoped API keys', async () => {
    authedKey('admin-uid', 'superadmin', [
      { resource: 'roost', id: 'roost_alpha', permissions: ['read'] },
    ]);
    seedSite('site-a', { name: 'Alpha' });
    seedSite('site-b', { name: 'Beta' });

    const res = await sitesGET(createMockRequest('http://localhost/api/sites'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sites).toEqual([]);
  });

  it('keeps legacy unscoped keys on the account view with a deprecation header', async () => {
    authedKey('admin-uid', 'superadmin', null, { isLegacy: true });
    seedSite('site-a', { name: 'Alpha' });
    seedSite('site-b', { name: 'Beta' });

    const res = await sitesGET(createMockRequest('http://localhost/api/sites'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sites.map((s: { id: string }) => s.id)).toEqual(['site-a', 'site-b']);
    expect(res.headers.get('X-Roost-Deprecation')).toContain('legacy-key-scope-missing');
  });
});

describe('/api/sites/{siteId}', () => {
  it('returns site detail for a caller with site read scope', async () => {
    authedKey('admin-uid', 'superadmin', [siteScope('site-a', 'read')]);
    seedSite('site-a', { name: 'Alpha', owner: 'admin-uid', plan: 'pro' });

    const res = await siteGET(
      createMockRequest('http://localhost/api/sites/site-a'),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      id: 'site-a',
      name: 'Alpha',
      owner: 'admin-uid',
      plan: 'pro',
      timezone: 'UTC',
    });
  });

  it('creates a site and replays matching idempotency keys', async () => {
    authedKey('admin-uid', 'superadmin', [siteScope('*', 'admin')]);
    const request = () =>
      createMockRequest('http://localhost/api/sites', {
        method: 'POST',
        headers: { 'Idempotency-Key': 'create-site-a' },
        body: { siteId: 'site-new', name: 'New Site', timezone: 'America/Los_Angeles' },
      });

    const first = await sitesPOST(request());
    const second = await sitesPOST(request());
    const body = await second.json();

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get('Idempotent-Replayed')).toBe('true');
    expect(body.siteId).toBe('site-new');
    expect(docStore['sites/site-new']?.data?.name).toBe('New Site');
    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
  });

  it('rejects site creation for API keys without site admin scope', async () => {
    authedKey('admin-uid', 'superadmin', [
      { resource: 'roost', id: '*', permissions: ['admin'] },
    ]);

    const res = await sitesPOST(
      createMockRequest('http://localhost/api/sites', {
        method: 'POST',
        body: { siteId: 'site-new', name: 'New Site' },
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe('scope_insufficient');
    expect(docStore['sites/site-new']).toBeUndefined();
  });

  it('updates site settings through the site admin surface', async () => {
    authedKey('admin-uid', 'superadmin', [siteScope('site-a', 'admin')]);
    seedSite('site-a', { name: 'Old Name', owner: 'admin-uid' });

    const res = await sitePATCH(
      createMockRequest('http://localhost/api/sites/site-a', {
        method: 'PATCH',
        body: { name: 'New Name', timeFormat: '24h' },
      }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.changed).toBe(true);
    expect(body.updated).toEqual({ name: 'New Name', timeFormat: '24h' });
    expect(docStore['sites/site-a']?.data).toMatchObject({
      name: 'New Name',
      timeFormat: '24h',
    });
  });

  it('deletes a site through the site admin surface', async () => {
    authedKey('admin-uid', 'superadmin', [siteScope('site-a', 'admin')]);
    seedSite('site-a', { owner: 'admin-uid' });

    const res = await siteDELETE(
      createMockRequest('http://localhost/api/sites/site-a', { method: 'DELETE' }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ siteId: 'site-a', deleted: true });
    expect(docStore['sites/site-a']?.data).toBeNull();
  });
});
