/** @jest-environment node */

import { NextRequest } from 'next/server';

const mockVerifyIdToken = jest.fn();
const mockCreateSession = jest.fn();
const mockUserDocGet = jest.fn();

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (handler: unknown) => handler,
}));

jest.mock('@/lib/sessionManager.server', () => ({
  createSession: (...args: unknown[]) => mockCreateSession(...args),
  destroySession: jest.fn(),
  getSessionData: jest.fn(),
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({
    verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args),
  }),
  getAdminDb: () => ({
    collection: (collectionName: string) => ({
      doc: (docId: string) => ({
        get: () => mockUserDocGet(collectionName, docId),
      }),
    }),
  }),
}));

import { POST } from '@/app/api/auth/session/route';

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockVerifyIdToken.mockResolvedValue({ uid: 'user-1' });
  mockUserDocGet.mockResolvedValue({
    exists: true,
    data: () => ({ role: 'member' }),
  });
});

describe('POST /api/auth/session', () => {
  it('rejects an existing soft-deleted user before creating a session', async () => {
    mockUserDocGet.mockResolvedValue({
      exists: true,
      data: () => ({ deletedAt: Date.now() }),
    });

    const res = await POST(request({ idToken: 'firebase-id-token' }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe('User is deleted or inactive');
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('allows first login when users doc is not bootstrapped yet', async () => {
    mockUserDocGet.mockResolvedValue({
      exists: false,
      data: () => undefined,
    });

    const res = await POST(request({ idToken: 'firebase-id-token', durationDays: 3 }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockCreateSession).toHaveBeenCalledWith('user-1', 3);
  });
});
