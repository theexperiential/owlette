/** @jest-environment node */

import { NextRequest } from 'next/server';

type TokenDoc = Record<string, unknown> & { id: string };

let tokenDocs: TokenDoc[] = [];
const deletedIds: string[] = [];

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (handler: unknown) => handler,
}));

jest.mock('@/lib/authorizedHandler.server', () => ({
  authorizedSiteHandler: () => (handler: (...args: unknown[]) => unknown) =>
    async (request: NextRequest, routeContext: { params: Promise<{ siteId: string }> }) => {
      const params = await routeContext.params;
      return handler(
        request,
        {
          actor: { type: 'user', userId: 'test-admin', role: 'superadmin', sites: [params.siteId] },
          siteId: params.siteId,
          correlationId: 'corr-test',
          auth: { userId: 'test-admin', keyContext: null },
          scopeCheck: { isLegacy: false },
        },
        routeContext,
      );
    },
}));

jest.mock('@/lib/firebase-admin', () => ({
  adminDb: {
    value: {
      collection: () => tokenCollection(),
      batch: () => ({
        delete: (ref: { id: string }) => deletedIds.push(ref.id),
        commit: jest.fn(async () => undefined),
      }),
    },
  },
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

function tokenCollection(filters: Array<[string, unknown]> = []) {
  return {
    where: (field: string, _op: string, value: unknown) => tokenCollection([...filters, [field, value]]),
    doc: (id: string) => ({
      get: async () => {
        const data = tokenDocs.find((doc) => doc.id === id);
        return { exists: !!data, data: () => data };
      },
      delete: async () => deletedIds.push(id),
    }),
    get: async () => ({
      docs: tokenDocs
        .filter((doc) => filters.every(([field, value]) => doc[field] === value))
        .map((doc) => ({
          id: doc.id,
          ref: { id: doc.id },
          data: () => doc,
        })),
    }),
  };
}

const timestamp = (iso: string) => ({ toDate: () => new Date(iso) });
// Lifecycle timestamps (supersededAt/retiresAt/expiresAt) are read via
// tokenTimestampToMillis, which needs .toMillis() — Firestore Timestamps
// expose both; the display path uses .toDate(). Model that faithfully.
const lifecycleTs = (ms: number) => ({ toMillis: () => ms, toDate: () => new Date(ms) });

import { GET } from '@/app/api/sites/[siteId]/agent-tokens/route';
import { POST } from '@/app/api/sites/[siteId]/agent-tokens/revoke/route';

beforeEach(() => {
  tokenDocs = [];
  deletedIds.length = 0;
});

describe('/api/sites/{siteId}/agent-tokens', () => {
  it('lists site tokens sorted newest first', async () => {
    tokenDocs = [
      { id: 'old', siteId: 'site-a', machineId: 'm1', createdAt: timestamp('2026-01-01T00:00:00Z') },
      { id: 'new', siteId: 'site-a', machineId: 'm2', createdAt: timestamp('2026-02-01T00:00:00Z') },
      { id: 'other', siteId: 'site-b', machineId: 'm3', createdAt: timestamp('2026-03-01T00:00:00Z') },
    ];

    const res = await GET(
      new NextRequest('http://localhost/api/sites/site-a/agent-tokens'),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.count).toBe(2);
    expect(json.tokens.map((t: { id: string }) => t.id)).toEqual(['new', 'old']);
  });

  it('hides superseded and expired tokens; reports prunableCount', async () => {
    const now = Date.now();
    tokenDocs = [
      { id: 'live', siteId: 'site-a', machineId: 'm1', createdAt: timestamp('2026-02-01T00:00:00Z') },
      // superseded past grace → dead → hidden + counted prunable
      { id: 'retired', siteId: 'site-a', machineId: 'm1', supersededAt: now - 600_000, retiresAt: lifecycleTs(now - 300_000), createdAt: timestamp('2026-01-01T00:00:00Z') },
      // superseded but in grace → hidden, NOT prunable
      { id: 'grace', siteId: 'site-a', machineId: 'm2', supersededAt: now, retiresAt: lifecycleTs(now + 60_000), createdAt: timestamp('2026-01-15T00:00:00Z') },
      // expired → dead → hidden + counted prunable
      { id: 'expired', siteId: 'site-a', machineId: 'm3', expiresAt: lifecycleTs(now - 1000), createdAt: timestamp('2026-01-10T00:00:00Z') },
    ];

    const res = await GET(
      new NextRequest('http://localhost/api/sites/site-a/agent-tokens'),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.tokens.map((t: { id: string }) => t.id)).toEqual(['live']);
    expect(json.count).toBe(1);
    expect(json.prunableCount).toBe(2);
  });
});

describe('/api/sites/{siteId}/agent-tokens/revoke', () => {
  it('revokes all tokens for a machine within the path site', async () => {
    tokenDocs = [
      { id: 'delete-me', siteId: 'site-a', machineId: 'm1' },
      { id: 'keep-other-site', siteId: 'site-b', machineId: 'm1' },
    ];

    const res = await POST(
      new NextRequest('http://localhost/api/sites/site-a/agent-tokens/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineId: 'm1' }),
      }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.revokedCount).toBe(1);
    expect(deletedIds).toEqual(['delete-me']);
  });

  it('machineId + latestOnly revokes ONLY the most-recently-used live token (preserves siblings)', async () => {
    const now = Date.now();
    tokenDocs = [
      { id: 'stale', siteId: 'site-a', machineId: 'm1', lastUsed: lifecycleTs(now - 3_600_000), createdAt: lifecycleTs(now - 7_200_000) },
      { id: 'fresh', siteId: 'site-a', machineId: 'm1', lastUsed: lifecycleTs(now - 60_000), createdAt: lifecycleTs(now - 120_000) },
      { id: 'dead', siteId: 'site-a', machineId: 'm1', supersededAt: now - 600_000, retiresAt: lifecycleTs(now - 300_000) },
      { id: 'other-machine', siteId: 'site-a', machineId: 'm2', lastUsed: lifecycleTs(now) },
    ];

    const res = await POST(
      new NextRequest('http://localhost/api/sites/site-a/agent-tokens/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineId: 'm1', latestOnly: true }),
      }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.revokedCount).toBe(1);
    expect(deletedIds).toEqual(['fresh']); // only the freshest live token; siblings kept
  });

  it('machineId + latestOnly with only dead tokens revokes nothing', async () => {
    const now = Date.now();
    tokenDocs = [
      { id: 'dead1', siteId: 'site-a', machineId: 'm1', supersededAt: now - 600_000, retiresAt: lifecycleTs(now - 300_000) },
      { id: 'dead2', siteId: 'site-a', machineId: 'm1', expiresAt: lifecycleTs(now - 1000) },
    ];

    const res = await POST(
      new NextRequest('http://localhost/api/sites/site-a/agent-tokens/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineId: 'm1', latestOnly: true }),
      }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.revokedCount).toBe(0);
    expect(deletedIds).toEqual([]);
  });

  it('prune deletes only dead tokens (superseded-retired / expired), never live', async () => {
    const now = Date.now();
    tokenDocs = [
      { id: 'live', siteId: 'site-a', machineId: 'm1' },
      { id: 'retired', siteId: 'site-a', supersededAt: now - 600_000, retiresAt: lifecycleTs(now - 300_000) },
      { id: 'grace', siteId: 'site-a', supersededAt: now, retiresAt: lifecycleTs(now + 60_000) },
      { id: 'expired', siteId: 'site-a', expiresAt: lifecycleTs(now - 1000) },
      { id: 'other-site-dead', siteId: 'site-b', expiresAt: lifecycleTs(now - 1000) },
    ];

    const res = await POST(
      new NextRequest('http://localhost/api/sites/site-a/agent-tokens/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prune: true }),
      }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.revokedCount).toBe(2);
    expect([...deletedIds].sort()).toEqual(['expired', 'retired']);
  });

  it('rejects a request with no revoke target', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/sites/site-a/agent-tokens/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );

    expect(res.status).toBe(400);
  });

  it('rejects conflicting revoke modes so latestOnly can never fall through to all', async () => {
    tokenDocs = [{ id: 'x', siteId: 'site-a', machineId: 'm1' }];
    const res = await POST(
      new NextRequest('http://localhost/api/sites/site-a/agent-tokens/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineId: 'm1', latestOnly: true, all: true }),
      }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );
    expect(res.status).toBe(400);
    expect(deletedIds).toEqual([]); // nothing deleted
  });

  it('rejects latestOnly without machineId', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/sites/site-a/agent-tokens/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ latestOnly: true }),
      }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );
    expect(res.status).toBe(400);
  });
});
