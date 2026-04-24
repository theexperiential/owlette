/** @jest-environment node */

import { NextRequest } from 'next/server';

const mockGetSession = jest.fn();
jest.mock('@/lib/sessionManager.server', () => ({
  getSessionFromRequest: (...args: unknown[]) => mockGetSession(...args),
}));

const mockVerifyIdToken = jest.fn();
const mockDocGet = jest.fn();

jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: mockVerifyIdToken }),
  getAdminDb: () => ({
    collection: (colName: string) => ({
      doc: (docId: string) => ({
        get: () => mockDocGet(colName, docId),
      }),
    }),
  }),
}));

import { requireAdminWithSiteAccess } from '@/lib/apiHelpers.server';

function makeRequest(url = 'http://localhost/test', init?: RequestInit) {
  return new NextRequest(
    new URL(url),
    init as unknown as ConstructorParameters<typeof NextRequest>[1]
  );
}

function validSession(overrides = {}) {
  return {
    userId: 'user-1',
    expiresAt: Date.now() + 60_000,
    destroy: jest.fn(),
    ...overrides,
  };
}

/**
 * Build a docGet mock that resolves user + site docs per-call based on the
 * collection being queried. `userData` / `siteData` are the documents the
 * mock should return for `users/{userId}` and `sites/{siteId}` respectively.
 */
function mockDocs({
  userData,
  siteData,
  siteExists = true,
}: {
  userData: Record<string, unknown> | null;
  siteData: Record<string, unknown> | null;
  siteExists?: boolean;
}) {
  mockDocGet.mockImplementation((col: string) => {
    if (col === 'users') {
      return Promise.resolve(
        userData
          ? { exists: true, data: () => userData }
          : { exists: false, data: () => undefined }
      );
    }
    if (col === 'sites') {
      return Promise.resolve(
        siteExists
          ? { exists: true, data: () => siteData ?? {} }
          : { exists: false }
      );
    }
    return Promise.resolve({ exists: false });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue(validSession());
});

describe('requireAdminWithSiteAccess', () => {
  it('404s when the site does not exist', async () => {
    mockDocs({ userData: { role: 'superadmin' }, siteData: null, siteExists: false });
    await expect(
      requireAdminWithSiteAccess(makeRequest(), 'site-1')
    ).rejects.toThrow(expect.objectContaining({ status: 404 }));
  });

  it('allows superadmins without any site assignment', async () => {
    mockDocs({
      userData: { role: 'superadmin', sites: [] },
      siteData: { owner: 'someone-else' },
    });
    const { userId } = await requireAdminWithSiteAccess(makeRequest(), 'site-1');
    expect(userId).toBe('user-1');
  });

  it('allows admin role when assigned to the site', async () => {
    mockDocs({
      userData: { role: 'admin', sites: ['site-1'] },
      siteData: { owner: 'someone-else' },
    });
    const { userId } = await requireAdminWithSiteAccess(makeRequest(), 'site-1');
    expect(userId).toBe('user-1');
  });

  it('allows admin role when they own the site', async () => {
    mockDocs({
      userData: { role: 'admin', sites: [] },
      siteData: { owner: 'user-1' },
    });
    const { userId } = await requireAdminWithSiteAccess(makeRequest(), 'site-1');
    expect(userId).toBe('user-1');
  });

  it('rejects admin role without ownership or assignment', async () => {
    mockDocs({
      userData: { role: 'admin', sites: ['other-site'] },
      siteData: { owner: 'someone-else' },
    });
    await expect(
      requireAdminWithSiteAccess(makeRequest(), 'site-1')
    ).rejects.toThrow(expect.objectContaining({ status: 403 }));
  });

  it('rejects member role even when assigned to the site', async () => {
    // Regression: previously this was erroneously allowed through admin routes.
    mockDocs({
      userData: { role: 'member', sites: ['site-1'] },
      siteData: { owner: 'someone-else' },
    });
    await expect(
      requireAdminWithSiteAccess(makeRequest(), 'site-1')
    ).rejects.toThrow(expect.objectContaining({ status: 403 }));
  });

  it('rejects member role even when they own the site', async () => {
    mockDocs({
      userData: { role: 'member', sites: [] },
      siteData: { owner: 'user-1' },
    });
    await expect(
      requireAdminWithSiteAccess(makeRequest(), 'site-1')
    ).rejects.toThrow(expect.objectContaining({ status: 403 }));
  });

  it('rejects users without a role field', async () => {
    mockDocs({
      userData: { sites: ['site-1'] },
      siteData: { owner: 'user-1' },
    });
    await expect(
      requireAdminWithSiteAccess(makeRequest(), 'site-1')
    ).rejects.toThrow(expect.objectContaining({ status: 403 }));
  });
});
