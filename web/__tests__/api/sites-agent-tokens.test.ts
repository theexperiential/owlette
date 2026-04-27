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
});
