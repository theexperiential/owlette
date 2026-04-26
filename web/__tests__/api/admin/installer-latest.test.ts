/** @jest-environment node */

import { NextRequest } from 'next/server';

jest.mock('@/lib/logger', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  __esModule: true,
}));

let mockAuthorizedDeny = false;

jest.mock('@/lib/authorizedHandler.server', () => ({
  authorizedPlatformHandler: jest.fn(() => (handler: (...args: unknown[]) => unknown) => {
    return async (request: NextRequest, routeContext?: unknown) => {
      if (mockAuthorizedDeny) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
      return handler(
        request,
        {
          actor: {
            type: 'user',
            userId: 'test-admin',
            role: 'superadmin',
            sites: [],
          },
          correlationId: 'test-correlation',
        },
        routeContext,
      );
    };
  }),
}));

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
      doc: (_id?: string) => ({
        get: mockGet,
        set: mockSet,
        update: mockUpdate,
        delete: mockDelete,
        collection: () => ({
          doc: (_subId?: string) => ({
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

import { GET } from '@/app/api/admin/installer/latest/route';

function makeRequest(url = 'http://localhost/api/admin/installer/latest') {
  return new NextRequest(url);
}

describe('GET /api/admin/installer/latest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthorizedDeny = false;
  });

  it('returns installer metadata on success', async () => {
    mockGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        version: '2.2.1',
        download_url: 'https://storage.example.com/installer.exe',
        checksum_sha256: 'abc123',
        release_notes: 'Bug fixes',
        file_size: 1048576,
        uploaded_at: 1700000000000,
      }),
    });

    const res = await GET(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.installer.version).toBe('2.2.1');
    expect(json.installer.download_url).toBe('https://storage.example.com/installer.exe');
  });

  it('returns 404 when no metadata exists', async () => {
    mockGet.mockResolvedValueOnce({ exists: false });

    const res = await GET(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe('No installer metadata found');
  });

  it('returns 401 when unauthorized', async () => {
    mockAuthorizedDeny = true;

    const res = await GET(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Unauthorized');
  });

  it('returns correct response shape with all expected fields', async () => {
    mockGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        version: '2.2.1',
        download_url: 'https://storage.example.com/installer.exe',
        checksum_sha256: 'sha256hash',
        release_notes: 'New features',
        file_size: 2097152,
        uploaded_at: 1700000000000,
      }),
    });

    const res = await GET(makeRequest());
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.installer).toEqual(
      expect.objectContaining({
        version: expect.any(String),
        download_url: expect.any(String),
        checksum_sha256: expect.any(String),
        release_notes: expect.any(String),
      })
    );
    // Verify all fields exist on the installer object
    const fields = ['version', 'download_url', 'checksum_sha256', 'release_notes', 'file_size', 'uploaded_at'];
    for (const field of fields) {
      expect(json.installer).toHaveProperty(field);
    }
  });
});
