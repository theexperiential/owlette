/** @jest-environment node */

import { NextRequest } from 'next/server';
import { createHash } from 'crypto';

const mockGetSession = jest.fn();
jest.mock('@/lib/sessionManager.server', () => ({
  getSessionFromRequest: (...args: any[]) => mockGetSession(...args),
}));

const mockVerifyIdToken = jest.fn();
const mockDocGet = jest.fn();
const mockDocUpdate = jest.fn().mockResolvedValue(undefined);

const mockDoc = jest.fn();
const mockInnerDoc = jest.fn();

jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: mockVerifyIdToken }),
  getAdminDb: () => ({
    collection: (colName: string) => ({
      doc: (docId: string) => {
        mockDoc(colName, docId);
        return {
          get: () => mockDocGet(colName, docId),
          collection: (innerCol: string) => ({
            doc: (innerDocId: string) => {
              mockInnerDoc(innerCol, innerDocId);
              return {
                update: mockDocUpdate,
              };
            },
          }),
        };
      },
    }),
  }),
}));

import {
  ApiAuthError,
  requireSession,
  requireSessionOrIdToken,
  requireAdmin,
  requireAdminOrIdToken,
  requireSessionUser,
  assertUserHasSiteAccess,
} from '@/lib/apiAuth.server';

function makeRequest(url = 'http://localhost/test', init?: RequestInit) {
  return new NextRequest(new URL(url), init as any);
}

function validSession(overrides = {}) {
  return {
    userId: 'user-123',
    expiresAt: Date.now() + 60_000,
    destroy: jest.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('requireSession', () => {
  it('returns userId when session is valid', async () => {
    mockGetSession.mockResolvedValue(validSession());
    const result = await requireSession(makeRequest());
    expect(result).toBe('user-123');
  });

  it('throws 401 when session has no userId', async () => {
    mockGetSession.mockResolvedValue(validSession({ userId: null }));
    await expect(requireSession(makeRequest())).rejects.toThrow(
      expect.objectContaining({ status: 401 })
    );
  });

  it('throws 401 when session is expired and calls destroy', async () => {
    const session = validSession({ expiresAt: Date.now() - 10_000 });
    mockGetSession.mockResolvedValue(session);
    await expect(requireSession(makeRequest())).rejects.toThrow(
      expect.objectContaining({ status: 401 })
    );
    expect(session.destroy).toHaveBeenCalled();
  });
});

describe('requireSessionOrIdToken', () => {
  it('returns userId from valid session', async () => {
    mockGetSession.mockResolvedValue(validSession());
    const result = await requireSessionOrIdToken(makeRequest());
    expect(result).toBe('user-123');
  });

  it('falls back to Bearer token when session throws', async () => {
    mockGetSession.mockResolvedValue(validSession({ userId: null }));
    mockVerifyIdToken.mockResolvedValue({ uid: 'token-user' });
    const req = makeRequest('http://localhost/test', {
      headers: { authorization: 'Bearer test-token' },
    });
    const result = await requireSessionOrIdToken(req);
    expect(result).toBe('token-user');
    expect(mockVerifyIdToken).toHaveBeenCalledWith('test-token');
  });

  it('throws 401 when session fails and no Authorization header', async () => {
    mockGetSession.mockResolvedValue(validSession({ userId: null }));
    await expect(requireSessionOrIdToken(makeRequest())).rejects.toThrow(
      expect.objectContaining({ status: 401 })
    );
  });

  it('throws 401 when session fails and Bearer token is invalid', async () => {
    mockGetSession.mockResolvedValue(validSession({ userId: null }));
    mockVerifyIdToken.mockRejectedValue(new Error('bad token'));
    const req = makeRequest('http://localhost/test', {
      headers: { authorization: 'Bearer bad-token' },
    });
    await expect(requireSessionOrIdToken(req)).rejects.toThrow(
      expect.objectContaining({ status: 401, message: expect.stringContaining('Invalid ID token') })
    );
  });

  it('re-throws ApiAuthError when session fails and no Bearer header', async () => {
    const sessionError = new ApiAuthError(401, 'Unauthorized: Session expired');
    mockGetSession.mockRejectedValue(sessionError);
    await expect(requireSessionOrIdToken(makeRequest())).rejects.toBe(sessionError);
  });
});

describe('requireAdminOrIdToken', () => {
  const apiKeyHash = createHash('sha256').update('owk_test123').digest('hex');

  it('returns userId for admin via x-api-key header', async () => {
    mockDocGet.mockImplementation((col: string) => {
      if (col === 'api_keys') return Promise.resolve({ exists: true, data: () => ({ userId: 'admin-1', keyId: 'k1' }) });
      if (col === 'users') return Promise.resolve({ exists: true, data: () => ({ role: 'admin' }) });
      return Promise.resolve({ exists: false });
    });

    const req = makeRequest('http://localhost/test', {
      headers: { 'x-api-key': 'owk_test123' },
    });
    const result = await requireAdminOrIdToken(req);
    expect(result).toBe('admin-1');
    expect(mockDoc).toHaveBeenCalledWith('api_keys', apiKeyHash);
  });

  it('returns userId for admin via api_key query param', async () => {
    mockDocGet.mockImplementation((col: string) => {
      if (col === 'api_keys') return Promise.resolve({ exists: true, data: () => ({ userId: 'admin-2', keyId: 'k2' }) });
      if (col === 'users') return Promise.resolve({ exists: true, data: () => ({ role: 'admin' }) });
      return Promise.resolve({ exists: false });
    });

    const req = makeRequest('http://localhost/test?api_key=owk_test456');
    const result = await requireAdminOrIdToken(req);
    expect(result).toBe('admin-2');
  });

  it('throws 401 for invalid API key (doc does not exist)', async () => {
    mockDocGet.mockImplementation((col: string) => {
      if (col === 'api_keys') return Promise.resolve({ exists: false });
      return Promise.resolve({ exists: false });
    });

    const req = makeRequest('http://localhost/test', {
      headers: { 'x-api-key': 'owk_invalid' },
    });
    await expect(requireAdminOrIdToken(req)).rejects.toThrow(
      expect.objectContaining({ status: 401 })
    );
  });

  it('falls back to session/token when no API key present', async () => {
    mockGetSession.mockResolvedValue(validSession({ userId: 'session-admin' }));
    mockDocGet.mockImplementation((col: string) => {
      if (col === 'users') return Promise.resolve({ exists: true, data: () => ({ role: 'admin' }) });
      return Promise.resolve({ exists: false });
    });

    const result = await requireAdminOrIdToken(makeRequest());
    expect(result).toBe('session-admin');
  });

  it('throws 403 for non-admin user', async () => {
    mockGetSession.mockResolvedValue(validSession());
    mockDocGet.mockImplementation((col: string) => {
      if (col === 'users') return Promise.resolve({ exists: true, data: () => ({ role: 'user' }) });
      return Promise.resolve({ exists: false });
    });

    await expect(requireAdminOrIdToken(makeRequest())).rejects.toThrow(
      expect.objectContaining({ status: 403 })
    );
  });

  it('throws 403 when user doc does not exist', async () => {
    mockGetSession.mockResolvedValue(validSession());
    mockDocGet.mockResolvedValue({ exists: false, data: () => undefined });

    await expect(requireAdminOrIdToken(makeRequest())).rejects.toThrow(
      expect.objectContaining({ status: 403 })
    );
  });
});

describe('requireAdmin', () => {
  it('delegates to requireAdminOrIdToken', async () => {
    mockGetSession.mockResolvedValue(validSession({ userId: 'admin-user' }));
    mockDocGet.mockImplementation((col: string) => {
      if (col === 'users') return Promise.resolve({ exists: true, data: () => ({ role: 'admin' }) });
      return Promise.resolve({ exists: false });
    });

    const result = await requireAdmin(makeRequest());
    expect(result).toBe('admin-user');
  });
});

describe('requireSessionUser', () => {
  it('returns userId when session matches', async () => {
    mockGetSession.mockResolvedValue(validSession({ userId: 'user-abc' }));
    const result = await requireSessionUser(makeRequest(), 'user-abc');
    expect(result).toBe('user-abc');
  });

  it('throws 403 when session userId does not match', async () => {
    mockGetSession.mockResolvedValue(validSession({ userId: 'user-abc' }));
    await expect(requireSessionUser(makeRequest(), 'user-other')).rejects.toThrow(
      expect.objectContaining({ status: 403 })
    );
  });
});

describe('assertUserHasSiteAccess', () => {
  it('allows access when user is site owner', async () => {
    mockDocGet.mockImplementation((col: string) => {
      if (col === 'sites') return Promise.resolve({ exists: true, data: () => ({ owner: 'user-1', name: 'Site A' }) });
      if (col === 'users') return Promise.resolve({ exists: true, data: () => ({ role: 'user', sites: [] }) });
      return Promise.resolve({ exists: false });
    });

    const result = await assertUserHasSiteAccess('user-1', 'site-1');
    expect(result.siteId).toBe('site-1');
  });

  it('allows access when user is admin', async () => {
    mockDocGet.mockImplementation((col: string) => {
      if (col === 'sites') return Promise.resolve({ exists: true, data: () => ({ owner: 'other', name: 'Site B' }) });
      if (col === 'users') return Promise.resolve({ exists: true, data: () => ({ role: 'admin', sites: [] }) });
      return Promise.resolve({ exists: false });
    });

    const result = await assertUserHasSiteAccess('user-2', 'site-2');
    expect(result.siteId).toBe('site-2');
  });

  it('allows access when user is assigned to site', async () => {
    mockDocGet.mockImplementation((col: string) => {
      if (col === 'sites') return Promise.resolve({ exists: true, data: () => ({ owner: 'other', name: 'Site C' }) });
      if (col === 'users') return Promise.resolve({ exists: true, data: () => ({ role: 'user', sites: ['site-3'] }) });
      return Promise.resolve({ exists: false });
    });

    const result = await assertUserHasSiteAccess('user-3', 'site-3');
    expect(result.siteId).toBe('site-3');
  });

  it('throws 403 when user has no access', async () => {
    mockDocGet.mockImplementation((col: string) => {
      if (col === 'sites') return Promise.resolve({ exists: true, data: () => ({ owner: 'other' }) });
      if (col === 'users') return Promise.resolve({ exists: true, data: () => ({ role: 'user', sites: [] }) });
      return Promise.resolve({ exists: false });
    });

    await expect(assertUserHasSiteAccess('user-4', 'site-4')).rejects.toThrow(
      expect.objectContaining({ status: 403 })
    );
  });

  it('throws 404 when site does not exist', async () => {
    mockDocGet.mockImplementation((col: string) => {
      if (col === 'sites') return Promise.resolve({ exists: false });
      return Promise.resolve({ exists: false });
    });

    await expect(assertUserHasSiteAccess('user-5', 'site-missing')).rejects.toThrow(
      expect.objectContaining({ status: 404 })
    );
  });
});
