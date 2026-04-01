/** @jest-environment node */

import { NextRequest } from 'next/server';

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (handler: any) => handler,
}));
jest.mock('@/lib/logger', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  __esModule: true,
}));

jest.mock('@/lib/apiAuth.server', () => {
  class _ApiAuthError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    requireAdminOrIdToken: jest.fn().mockResolvedValue('test-admin'),
    requireAdmin: jest.fn().mockResolvedValue('test-admin'),
    ApiAuthError: _ApiAuthError,
  };
});

const { requireAdminOrIdToken, ApiAuthError } = jest.requireMock('@/lib/apiAuth.server');

const mockGet = jest.fn();
const mockSet = jest.fn().mockResolvedValue(undefined);
const mockUpdate = jest.fn().mockResolvedValue(undefined);
const mockDelete = jest.fn().mockResolvedValue(undefined);
const mockOrderBy = jest.fn().mockReturnThis();
const mockLimit = jest.fn().mockReturnThis();
const mockCollectionGet = jest.fn();

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: () => ({
      doc: (id?: string) => ({
        get: mockGet,
        set: mockSet,
        update: mockUpdate,
        delete: mockDelete,
        collection: () => ({
          doc: (subId?: string) => ({
            get: mockGet,
            set: mockSet,
            update: mockUpdate,
            delete: mockDelete,
            collection: () => ({
              doc: () => ({ get: mockGet, set: mockSet, update: mockUpdate }),
            }),
          }),
          orderBy: mockOrderBy,
          limit: mockLimit,
          get: mockCollectionGet,
        }),
      }),
    }),
  }),
  getAdminStorage: () => ({
    bucket: () => ({
      file: () => ({
        getSignedUrl: jest.fn().mockResolvedValue(['https://storage.example.com/signed']),
        exists: jest.fn().mockResolvedValue([true]),
        getMetadata: jest.fn().mockResolvedValue([{ size: '1048576' }]),
      }),
    }),
  }),
}));

import { GET } from '@/app/api/admin/installer/versions/route';

function makeRequest(query = '') {
  return new NextRequest(`http://localhost/api/admin/installer/versions${query}`);
}

describe('GET /api/admin/installer/versions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (requireAdminOrIdToken as jest.Mock).mockResolvedValue('test-admin');
  });

  it('returns versions array on success', async () => {
    mockCollectionGet.mockResolvedValueOnce({
      docs: [
        {
          id: '2.2.1',
          data: () => ({
            version: '2.2.1',
            download_url: 'https://storage.example.com/2.2.1.exe',
            checksum_sha256: 'abc',
            release_notes: 'Latest release',
            file_size: 2097152,
            uploaded_at: 1700000000000,
            uploaded_by: 'admin-user',
          }),
        },
        {
          id: '2.2.0',
          data: () => ({
            version: '2.2.0',
            download_url: 'https://storage.example.com/2.2.0.exe',
            checksum_sha256: 'def',
            release_notes: 'Previous release',
            file_size: 1048576,
            uploaded_at: 1699000000000,
            uploaded_by: 'admin-user',
          }),
        },
      ],
    });

    const res = await GET(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.versions).toHaveLength(2);
    expect(json.versions[0].version).toBe('2.2.1');
    expect(json.versions[1].version).toBe('2.2.0');
  });

  it('returns empty array when no versions exist', async () => {
    mockCollectionGet.mockResolvedValueOnce({ docs: [] });

    const res = await GET(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.versions).toEqual([]);
  });

  it('respects limit query parameter', async () => {
    mockCollectionGet.mockResolvedValueOnce({
      docs: [
        {
          id: '2.2.1',
          data: () => ({
            version: '2.2.1',
            download_url: 'https://storage.example.com/2.2.1.exe',
            checksum_sha256: null,
            release_notes: null,
            file_size: 1048576,
            uploaded_at: 1700000000000,
            uploaded_by: 'admin-user',
          }),
        },
      ],
    });

    const res = await GET(makeRequest('?limit=5'));
    await res.json();

    // orderBy and limit should have been called in the chain
    expect(mockOrderBy).toHaveBeenCalledWith('uploaded_at', 'desc');
    expect(mockLimit).toHaveBeenCalledWith(5);
  });

  it('returns 401 when unauthorized', async () => {
    (requireAdminOrIdToken as jest.Mock).mockRejectedValueOnce(
      new ApiAuthError(401, 'Unauthorized')
    );

    const res = await GET(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Unauthorized');
  });
});
