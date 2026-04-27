/** @jest-environment node */

import { NextRequest } from 'next/server';

const store = new Map<string, Record<string, unknown> | null>();

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (handler: unknown) => handler,
}));

jest.mock('@/lib/authorizedHandler.server', () => ({
  authorizedPlatformHandler: () => (handler: (...args: unknown[]) => unknown) =>
    (request: NextRequest, routeContext?: unknown) =>
      handler(
        request,
        {
          actor: { type: 'user', userId: 'test-admin', role: 'superadmin', sites: [] },
          correlationId: 'corr-test',
          auth: { userId: 'test-admin', keyContext: null },
          scopeCheck: { isLegacy: false },
        },
        routeContext,
      ),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__SERVER_TS__' },
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDb(),
}));

function collectionPath(parts: string[]): string {
  return parts.join('/');
}

function mockDb() {
  return {
    collection: (name: string) => collectionRef([name]),
    batch: () => {
      const ops: Array<() => void> = [];
      return {
        set: (ref: { path: string }, data: Record<string, unknown>) => {
          ops.push(() => store.set(ref.path, data));
        },
        delete: (ref: { path: string }) => {
          ops.push(() => store.set(ref.path, null));
        },
        commit: async () => {
          ops.forEach((op) => op());
        },
      };
    },
  };
}

function collectionRef(parts: string[]) {
  const path = collectionPath(parts);
  const ref = {
    doc: (id: string) => docRef([...parts, id]),
    collection: (name: string) => collectionRef([...parts, name]),
    orderBy: () => ref,
    get: async () => ({
      docs: Array.from(store.entries())
        .filter(([docPath, data]) => data && docPath.startsWith(`${path}/`))
        .map(([docPath, data]) => ({
          id: docPath.slice(path.length + 1).split('/')[0],
          data: () => data,
        })),
    }),
  };
  return ref;
}

function docRef(parts: string[]) {
  const path = collectionPath(parts);
  return {
    path,
    collection: (name: string) => collectionRef([...parts, name]),
    get: async () => {
      const data = store.get(path);
      return {
        exists: !!data,
        data: () => data ?? undefined,
      };
    },
  };
}

import { GET, POST } from '@/app/api/account/api-keys/route';
import { DELETE } from '@/app/api/account/api-keys/[keyId]/route';

beforeEach(() => {
  store.clear();
});

describe('/api/account/api-keys', () => {
  it('lists API key metadata for the authenticated account', async () => {
    store.set('users/test-admin/api_keys/key-a', {
      name: 'CI',
      keyPrefix: 'owk_abc',
      createdAt: 123,
      lastUsedAt: null,
    });

    const res = await GET(new NextRequest('http://localhost/api/account/api-keys'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      success: true,
      keys: [{ id: 'key-a', name: 'CI', keyPrefix: 'owk_abc' }],
    });
  });

  it('creates a key and returns the raw key once', async () => {
    const res = await POST(new NextRequest('http://localhost/api/account/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Deploy' }),
    }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.name).toBe('Deploy');
    expect(json.key).toMatch(/^owk_/);

    expect(Array.from(store.keys()).some((p) => p.startsWith('users/test-admin/api_keys/'))).toBe(true);
    expect(Array.from(store.keys()).some((p) => p.startsWith('api_keys/'))).toBe(true);
  });
});

describe('/api/account/api-keys/{keyId}', () => {
  it('revokes a key by path id', async () => {
    store.set('users/test-admin/api_keys/key-a', {
      keyHash: 'hash-a',
      name: 'CI',
    });
    store.set('api_keys/hash-a', { userId: 'test-admin', keyId: 'key-a' });

    const res = await DELETE(
      new NextRequest('http://localhost/api/account/api-keys/key-a', { method: 'DELETE' }),
      { params: Promise.resolve({ keyId: 'key-a' }) },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(store.get('users/test-admin/api_keys/key-a')).toBeNull();
    expect(store.get('api_keys/hash-a')).toBeNull();
  });
});
