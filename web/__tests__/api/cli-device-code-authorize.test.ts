/** @jest-environment node */

import { NextRequest } from 'next/server';

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (handler: unknown) => handler,
}));

const mockRequireSessionOrIdToken = jest.fn();
const mockAssertUserHasSiteAccess = jest.fn();

jest.mock('@/lib/apiAuth.server', () => {
  class ApiAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.status = status;
    }
  }

  return {
    ApiAuthError,
    requireSessionOrIdToken: (...args: unknown[]) => mockRequireSessionOrIdToken(...args),
    assertUserHasSiteAccess: (...args: unknown[]) => mockAssertUserHasSiteAccess(...args),
  };
});

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: jest.fn(() => ({ __op: 'serverTimestamp' })),
  },
}));

const mockTxGet = jest.fn();
const mockTxSet = jest.fn();
const mockTxUpdate = jest.fn();
const mockUserRoleDoc = jest.fn();
let mockDeviceCodeExists = true;
let mockDeviceCodeData: Record<string, unknown>;

function mockDocRef(collectionName: string, id: string): Record<string, unknown> {
  return {
    id,
    get: async () => {
      if (collectionName === 'users') return mockUserRoleDoc(id);
      return { exists: false, data: () => undefined };
    },
    collection: (name: string) => mockCollectionRef(`${collectionName}/${id}/${name}`),
  };
}

function mockCollectionRef(name: string): Record<string, unknown> {
  return {
    doc: (id: string) => mockDocRef(name, id),
  };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => mockCollectionRef(name),
    runTransaction: async (callback: (tx: unknown) => unknown) =>
      callback({
        get: mockTxGet,
        set: mockTxSet,
        update: mockTxUpdate,
      }),
  }),
}));

import { POST } from '@/app/api/cli/device-code/authorize/route';

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/cli/device-code/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireSessionOrIdToken.mockResolvedValue('user-1');
  mockAssertUserHasSiteAccess.mockResolvedValue(undefined);
  mockUserRoleDoc.mockResolvedValue({
    exists: true,
    data: () => ({ role: 'admin' }),
  });
  mockDeviceCodeExists = true;
  mockDeviceCodeData = {
    status: 'pending',
    expiresAt: { toMillis: () => Date.now() + 60_000 },
  };
  mockTxGet.mockImplementation(async () => ({
    exists: mockDeviceCodeExists,
    data: () => mockDeviceCodeData,
  }));
});

describe('POST /api/cli/device-code/authorize', () => {
  it('authorizes a concrete chat scope after validating site access', async () => {
    const scopes = [{ resource: 'chat', id: 'site-1', permissions: ['read', 'write'] }];

    const res = await POST(
      request({
        code: 'PAIR-123',
        name: 'CLI',
        scopes,
        ttlDays: 30,
        environment: 'live',
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.keyId).toEqual(expect.any(String));
    expect(mockAssertUserHasSiteAccess).toHaveBeenCalledWith('user-1', 'site-1');
    expect(mockTxGet).toHaveBeenCalledTimes(1);
    expect(mockTxSet).toHaveBeenCalledTimes(2);
    expect(mockTxUpdate).toHaveBeenCalledTimes(1);
    expect(mockTxUpdate.mock.calls[0]![1]).toMatchObject({
      status: 'authorized',
      authorizedBy: 'user-1',
      name: 'CLI',
      scopes,
      environment: 'live',
      siteId: 'site-1',
    });
    expect(mockTxUpdate.mock.calls[0]![1].rawKey).toMatch(/^owk_live_/);
  });

  it('rejects an already authorised pairing phrase inside the transaction', async () => {
    mockDeviceCodeData = {
      status: 'authorized',
      expiresAt: { toMillis: () => Date.now() + 60_000 },
    };

    const res = await POST(
      request({
        code: 'PAIR-123',
        name: 'CLI',
        scopes: [{ resource: 'site', id: '*', permissions: ['read'] }],
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('pairing_phrase_already_authorized');
    expect(mockTxSet).not.toHaveBeenCalled();
    expect(mockTxUpdate).not.toHaveBeenCalled();
  });

  it('rejects user scopes for non-superadmin signers', async () => {
    const res = await POST(
      request({
        code: 'PAIR-123',
        name: 'CLI',
        scopes: [{ resource: 'user', id: '*', permissions: ['admin'] }],
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toMatch(/application\/problem\+json/);
    expect(body.type).toBe('https://owlette.app/problems/forbidden');
    expect(body.code).toBe('forbidden');
    expect(body.detail).toBe(
      'superadmin access required to create user or installer scopes',
    );
    expect(mockTxSet).not.toHaveBeenCalled();
    expect(mockTxUpdate).not.toHaveBeenCalled();
  });

  it('rejects concrete installer scope ids', async () => {
    const res = await POST(
      request({
        code: 'PAIR-123',
        name: 'CLI',
        scopes: [{ resource: 'installer', id: '2.11.0', permissions: ['admin'] }],
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/problem\+json/);
    expect(body.type).toBe('https://owlette.app/problems/validation-failed');
    expect(body.code).toBe('validation_failed');
    expect(body.detail).toBe('installer scopes must use id "*"');
    expect(body.errors?.['body.scopes']).toContain('installer scope must use id "*"');
    expect(mockUserRoleDoc).not.toHaveBeenCalled();
    expect(mockTxSet).not.toHaveBeenCalled();
    expect(mockTxUpdate).not.toHaveBeenCalled();
  });
});
