/** @jest-environment node */

const mockDocGet = jest.fn();

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (_colName: string) => ({
      doc: (_docId: string) => ({
        get: () => mockDocGet(),
      }),
    }),
  }),
}));

import { getUserSiteIds } from '@/lib/apiHelpers.server';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getUserSiteIds', () => {
  it('returns string site ids from the user document', async () => {
    mockDocGet.mockResolvedValue({
      exists: true,
      data: () => ({ sites: ['site-1', 42, 'site-2', null] }),
    });

    await expect(getUserSiteIds('user-1')).resolves.toEqual(['site-1', 'site-2']);
  });

  it('returns an empty list when the user doc does not exist', async () => {
    mockDocGet.mockResolvedValue({ exists: false, data: () => undefined });

    await expect(getUserSiteIds('missing')).resolves.toEqual([]);
  });

  it('returns an empty list when sites is absent or malformed', async () => {
    mockDocGet.mockResolvedValue({ exists: true, data: () => ({ sites: 'site-1' }) });

    await expect(getUserSiteIds('user-1')).resolves.toEqual([]);
  });
});
