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

const mockBatchSet = jest.fn();
const mockBatchUpdate = jest.fn();
const mockBatchCommit = jest.fn(async () => undefined);
const mockUserRoleDoc = jest.fn();

function mockDocRef(collectionName: string, id: string): Record<string, unknown> {
  return {
    id,
    get: async () => {
      if (collectionName === 'users') return mockUserRoleDoc(id);
      if (collectionName === 'cli_device_codes') {
        return {
          exists: true,
          data: () => ({
            status: 'pending',
            expiresAt: { toMillis: () => Date.now() + 60_000 },
          }),
        };
      }
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
    batch: () => ({
      set: mockBatchSet,
      update: mockBatchUpdate,
      commit: mockBatchCommit,
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
});

describe('POST /api/cli/device-code/authorize', () => {
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
    expect(body.error).toBe('superadmin access required to create user or installer scopes');
    expect(mockBatchCommit).not.toHaveBeenCalled();
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
    expect(body.error).toBe('installer scopes must use id "*"');
    expect(mockUserRoleDoc).not.toHaveBeenCalled();
    expect(mockBatchCommit).not.toHaveBeenCalled();
  });
});
