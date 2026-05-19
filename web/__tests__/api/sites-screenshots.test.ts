/** @jest-environment node */

import { NextRequest } from 'next/server';

const store = new Map<string, Record<string, unknown> | null>();
const deletedStoragePaths: string[] = [];

jest.mock('@/lib/authorizedHandler.server', () => ({
  authorizedSiteHandler: () => (handler: (...args: unknown[]) => unknown) =>
    async (request: NextRequest, routeContext: { params: Promise<{ siteId: string; machineId: string }> }) => {
      const params = await routeContext.params;
      return handler(
        request,
        {
          actor: { type: 'user', userId: 'test-admin', role: 'admin', sites: [params.siteId] },
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
  getAdminDb: () => ({
    collection: (name: string) => collectionRef([name]),
  }),
  getAdminStorage: () => ({
    bucket: (name: string) => ({
      name,
      file: (path: string) => ({
        delete: async () => deletedStoragePaths.push(path),
      }),
    }),
  }),
}));

function pathFor(parts: string[]): string {
  return parts.join('/');
}

function collectionRef(parts: string[]) {
  return {
    doc: (id: string) => docRef([...parts, id]),
    get: async () => {
      const prefix = `${pathFor(parts)}/`;
      const docs = Array.from(store.entries())
        .filter(([path, data]) => data && path.startsWith(prefix))
        .map(([path, data]) => ({
          id: path.slice(prefix.length).split('/')[0],
          data: () => data,
          ref: docRef(path.split('/')),
        }));
      return { empty: docs.length === 0, docs };
    },
  };
}

function docRef(parts: string[]) {
  const path = pathFor(parts);
  return {
    collection: (name: string) => collectionRef([...parts, name]),
    get: async () => {
      const data = store.get(path);
      return { exists: !!data, data: () => data ?? undefined };
    },
    delete: async () => {
      store.set(path, null);
    },
    update: async (patch: Record<string, unknown>) => {
      store.set(path, { ...(store.get(path) ?? {}), ...patch });
    },
  };
}

import { DELETE } from '@/app/api/sites/[siteId]/machines/[machineId]/screenshots/route';

beforeEach(() => {
  store.clear();
  deletedStoragePaths.length = 0;
  process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'bucket.example';
});

describe('DELETE /api/sites/{siteId}/machines/{machineId}/screenshots', () => {
  it('deletes a single screenshot document and storage object', async () => {
    store.set('sites/site-a/machines/m1/screenshots/shot-1', {
      url: 'https://storage.googleapis.com/bucket.example/screenshots/site-a/m1/shot-1.jpg?x=1',
    });

    const res = await DELETE(
      new NextRequest('http://localhost/api/sites/site-a/machines/m1/screenshots?screenshotId=shot-1', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ siteId: 'site-a', machineId: 'm1' }) },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, deleted: 1 });
    expect(store.get('sites/site-a/machines/m1/screenshots/shot-1')).toBeNull();
    expect(deletedStoragePaths).toEqual(['screenshots/site-a/m1/shot-1.jpg']);
  });
});
