/** @jest-environment node */

import { NextRequest } from 'next/server';

const store = new Map<string, Record<string, unknown> | null>();
const mockRequireSessionOrIdToken = jest.fn();
const mockAssertUserHasSiteAccess = jest.fn();
const mockEmitMutation = jest.fn();

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (handler: unknown) => handler,
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
}));

jest.mock('@/lib/apiAuth.server', () => {
  class ApiAuthError extends Error {
    status: number;
    code?: string;
    details?: Record<string, unknown>;

    constructor(
      status: number,
      message: string,
      opts?: { code?: string; details?: Record<string, unknown> },
    ) {
      super(message);
      this.status = status;
      this.code = opts?.code;
      this.details = opts?.details;
    }
  }

  return {
    ApiAuthError,
    requireSessionOrIdToken: (...args: unknown[]) =>
      mockRequireSessionOrIdToken(...args),
    assertUserHasSiteAccess: (...args: unknown[]) =>
      mockAssertUserHasSiteAccess(...args),
  };
});

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
        update: (ref: { path: string }, data: Record<string, unknown>) => {
          ops.push(() => store.set(ref.path, { ...(store.get(ref.path) ?? {}), ...data }));
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

import { POST } from '@/app/api/keys/route';
import { DELETE } from '@/app/api/keys/[keyId]/route';
import { POST as rotatePOST } from '@/app/api/keys/[keyId]/rotate/route';

function makePost(body: Record<string, unknown>) {
  return POST(new NextRequest('http://localhost/api/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

function makeDelete(keyId: string) {
  return DELETE(
    new NextRequest(`http://localhost/api/keys/${keyId}`, { method: 'DELETE' }),
    { params: Promise.resolve({ keyId }) },
  );
}

function makeRotate(keyId: string, body: Record<string, unknown> = {}) {
  return rotatePOST(
    new NextRequest(`http://localhost/api/keys/${keyId}/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ keyId }) },
  );
}

beforeEach(() => {
  store.clear();
  jest.clearAllMocks();
  mockRequireSessionOrIdToken.mockResolvedValue('user-member');
  mockAssertUserHasSiteAccess.mockResolvedValue({ siteId: 'site-1', siteData: {} });
});

describe('/api/keys POST', () => {
  it.each(['user', 'installer'] as const)(
    'rejects non-superadmin creation of %s scopes',
    async (resource) => {
      store.set('users/user-member', { role: 'member' });

      const res = await makePost({
        name: 'Platform key',
        environment: 'live',
        scopes: [{ resource, id: '*', permissions: ['admin'] }],
      });
      const body = await res.json();

      expect(res.status).toBe(403);
      expect(body.code).toBe('forbidden');
      expect(body.detail).toBe(
        'superadmin access required to create user or installer scopes',
      );
      expect(Array.from(store.keys()).some((p) => p.startsWith('api_keys/'))).toBe(false);
    },
  );

  it('allows a superadmin to create superadmin-only scopes', async () => {
    mockRequireSessionOrIdToken.mockResolvedValue('user-superadmin');
    store.set('users/user-superadmin', { role: 'superadmin' });

    const scopes = [
      { resource: 'user', id: '*', permissions: ['read', 'admin'] },
      { resource: 'installer', id: '*', permissions: ['read', 'write', 'admin'] },
    ];

    const res = await makePost({
      name: 'Platform key',
      environment: 'live',
      scopes,
      ttlDays: 7,
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.key).toMatch(/^owk_live_/);
    expect(body.scopes).toEqual(scopes);

    const lookupRecord = Array.from(store.entries()).find(([p]) =>
      p.startsWith('api_keys/'),
    )?.[1];
    expect(lookupRecord).toMatchObject({
      userId: 'user-superadmin',
      keyId: body.keyId,
      environment: 'live',
      scopes,
      expiresAt: body.expiresAt,
    });
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'api_key_mutated',
        siteId: '',
        actor: 'user:user-superadmin',
        targetId: body.keyId,
        attributes: expect.objectContaining({
          verb: 'create',
          endpoint: '/api/keys',
          method: 'POST',
          environment: 'live',
          keyPrefix: body.keyPrefix,
          scopeCount: 2,
          ttlDays: 7,
        }),
      }),
    );
    expect(JSON.stringify(mockEmitMutation.mock.calls)).not.toContain(body.key);
  });

  it('rejects concrete ids for superadmin-only scope resources', async () => {
    mockRequireSessionOrIdToken.mockResolvedValue('user-superadmin');
    store.set('users/user-superadmin', { role: 'superadmin' });

    const res = await makePost({
      name: 'Narrow platform key',
      environment: 'live',
      scopes: [{ resource: 'user', id: 'some-user', permissions: ['admin'] }],
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe('validation_failed');
    expect(body.detail).toBe('user scopes must use id "*"');
  });

  it('still validates explicit site scopes against caller site access', async () => {
    const res = await makePost({
      name: 'Site key',
      environment: 'test',
      scopes: [{ resource: 'site', id: 'site-1', permissions: ['read'] }],
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.environment).toBe('test');
    expect(body.scopes).toEqual([
      { resource: 'site', id: 'site-1', permissions: ['read'] },
    ]);
    expect(mockAssertUserHasSiteAccess).toHaveBeenCalledWith('user-member', 'site-1');
  });
});

describe('/api/keys/{keyId} DELETE', () => {
  it('audits successful key revocation', async () => {
    store.set('users/user-member/api_keys/key-a', {
      keyHash: 'hash-a',
      keyPrefix: 'owk_live_a',
    });
    store.set('api_keys/hash-a', { userId: 'user-member', keyId: 'key-a' });

    const res = await makeDelete('key-a');

    expect(res.status).toBe(200);
    expect(store.get('users/user-member/api_keys/key-a')).toBeNull();
    expect(store.get('api_keys/hash-a')).toBeNull();
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'api_key_mutated',
        siteId: '',
        actor: 'user:user-member',
        targetId: 'key-a',
        attributes: expect.objectContaining({
          verb: 'revoke',
          endpoint: '/api/keys/key-a',
          method: 'DELETE',
        }),
      }),
    );
  });
});

describe('/api/keys/{keyId}/rotate POST', () => {
  it('audits successful key rotation without exposing raw key material', async () => {
    store.set('users/user-member/api_keys/key-old', {
      keyHash: 'hash-old',
      keyPrefix: 'owk_live_old',
      environment: 'live',
      scopes: [{ resource: 'site', id: 'site-1', permissions: ['read'] }],
      name: 'old key',
    });
    store.set('api_keys/hash-old', { userId: 'user-member', keyId: 'key-old' });

    const res = await makeRotate('key-old', { ttlDays: 14 });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.key).toMatch(/^owk_live_/);
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'api_key_mutated',
        siteId: '',
        actor: 'user:user-member',
        targetId: body.keyId,
        attributes: expect.objectContaining({
          verb: 'rotate',
          endpoint: '/api/keys/key-old/rotate',
          method: 'POST',
          environment: 'live',
          keyPrefix: body.keyPrefix,
          rotatedFromKeyId: 'key-old',
          scopeCount: 1,
          ttlDays: 14,
        }),
      }),
    );
    expect(JSON.stringify(mockEmitMutation.mock.calls)).not.toContain(body.key);
  });
});
