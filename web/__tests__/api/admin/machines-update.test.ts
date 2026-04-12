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
    ApiAuthError: _ApiAuthError,
  };
});

const { ApiAuthError } = jest.requireMock('@/lib/apiAuth.server');

const mockRequireAdminWithSiteAccess = jest.fn().mockResolvedValue({ userId: 'test-admin' });
jest.mock('@/lib/apiHelpers.server', () => ({
  requireAdminWithSiteAccess: (...args: any[]) => mockRequireAdminWithSiteAccess(...args),
}));

const mockGet = jest.fn();
const mockSet = jest.fn().mockResolvedValue(undefined);
const mockWhere = jest.fn();
const mockCollectionGet = jest.fn();

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (_colName: string) => ({
      doc: (_docId: string) => ({
        get: mockGet,
        collection: () => ({
          doc: () => ({
            collection: () => ({
              doc: () => ({
                set: mockSet,
              }),
            }),
            where: mockWhere,
            get: mockCollectionGet,
          }),
          where: mockWhere,
          get: mockCollectionGet,
        }),
      }),
    }),
  }),
}));

import { POST } from '@/app/api/admin/machines/update/route';

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/admin/machines/update', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const VALID_INSTALLER_DATA = {
  version: '2.3.0',
  download_url: 'https://storage.example.com/installer.exe',
  checksum_sha256: 'abc123def456',
};

describe('POST /api/admin/machines/update', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireAdminWithSiteAccess.mockResolvedValue({ userId: 'test-admin' });
  });

  it('sends update to specified machines', async () => {
    // installer_metadata/latest
    mockGet.mockResolvedValueOnce({
      exists: true,
      data: () => VALID_INSTALLER_DATA,
    });

    const res = await POST(
      makeRequest({ siteId: 'site1', machineIds: ['machine-a', 'machine-b'] })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.version).toBe('2.3.0');
    expect(json.sent).toBe(2);
    expect(json.failed).toBe(0);
    expect(json.machines).toHaveLength(2);
    expect(mockSet).toHaveBeenCalledTimes(2);
  });

  it('sends update to all online machines when machineIds omitted', async () => {
    // installer_metadata/latest
    mockGet.mockResolvedValueOnce({
      exists: true,
      data: () => VALID_INSTALLER_DATA,
    });

    // machines query
    mockWhere.mockReturnValueOnce({
      get: jest.fn().mockResolvedValueOnce({
        docs: [
          { id: 'machine-1' },
          { id: 'machine-2' },
          { id: 'machine-3' },
        ],
      }),
    });

    const res = await POST(makeRequest({ siteId: 'site1' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.sent).toBe(3);
    expect(mockWhere).toHaveBeenCalledWith('online', '==', true);
  });

  it('returns 400 when siteId is missing', async () => {
    const res = await POST(makeRequest({}));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/siteId/i);
  });

  it('returns 400 when machineIds is empty array', async () => {
    const res = await POST(makeRequest({ siteId: 'site1', machineIds: [] }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/machineIds/i);
  });

  it('returns 404 when no installer uploaded', async () => {
    mockGet.mockResolvedValueOnce({ exists: false });

    const res = await POST(makeRequest({ siteId: 'site1', machineIds: ['m1'] }));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toMatch(/no installer/i);
  });

  it('returns 500 when checksum is missing', async () => {
    mockGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ ...VALID_INSTALLER_DATA, checksum_sha256: null }),
    });

    const res = await POST(makeRequest({ siteId: 'site1', machineIds: ['m1'] }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toMatch(/checksum/i);
  });

  it('returns 404 when no online machines found', async () => {
    mockGet.mockResolvedValueOnce({
      exists: true,
      data: () => VALID_INSTALLER_DATA,
    });

    mockWhere.mockReturnValueOnce({
      get: jest.fn().mockResolvedValueOnce({ docs: [] }),
    });

    const res = await POST(makeRequest({ siteId: 'site1' }));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toMatch(/no online machines/i);
  });

  it('returns 403 when user lacks site access', async () => {
    mockRequireAdminWithSiteAccess.mockRejectedValueOnce(
      new ApiAuthError(403, 'Forbidden')
    );

    const res = await POST(makeRequest({ siteId: 'site1', machineIds: ['m1'] }));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error).toBe('Forbidden');
  });
});
