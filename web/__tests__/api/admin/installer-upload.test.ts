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

const { requireAdmin, ApiAuthError } = jest.requireMock('@/lib/apiAuth.server');

const mockGet = jest.fn();
const mockSet = jest.fn().mockResolvedValue(undefined);
const mockUpdate = jest.fn().mockResolvedValue(undefined);
const mockDelete = jest.fn().mockResolvedValue(undefined);
const mockOrderBy = jest.fn().mockReturnThis();
const mockLimit = jest.fn().mockReturnThis();
const mockCollectionGet = jest.fn();
const mockGetSignedUrl = jest.fn().mockResolvedValue(['https://storage.example.com/signed']);
const mockExists = jest.fn().mockResolvedValue([true]);
const mockGetMetadata = jest.fn().mockResolvedValue([{ size: '1048576' }]);
const mockDownload = jest.fn().mockResolvedValue([Buffer.from('fake-installer-content')]);

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
        getSignedUrl: mockGetSignedUrl,
        exists: mockExists,
        getMetadata: mockGetMetadata,
        download: mockDownload,
      }),
    }),
  }),
}));

import { POST, PUT } from '@/app/api/admin/installer/upload/route';

function makePostRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/admin/installer/upload', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function makePutRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/admin/installer/upload', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/admin/installer/upload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (requireAdmin as jest.Mock).mockResolvedValue('test-admin');
    mockGetSignedUrl.mockResolvedValue(['https://storage.example.com/signed-upload']);
  });

  it('returns signed upload URL on success', async () => {
    const res = await POST(
      makePostRequest({ version: '2.2.1', fileName: 'Owlette-Installer.exe' })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.uploadUrl).toBe('https://storage.example.com/signed-upload');
    expect(json.uploadId).toBeDefined();
    expect(json.storagePath).toContain('2.2.1');
    expect(json.expiresAt).toBeDefined();
    expect(mockSet).toHaveBeenCalled();
  });

  it('returns 400 for invalid version format', async () => {
    const res = await POST(
      makePostRequest({ version: 'not-semver', fileName: 'Owlette-Installer.exe' })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/invalid version/i);
  });

  it('returns 400 when fileName does not end with .exe', async () => {
    const res = await POST(
      makePostRequest({ version: '2.2.1', fileName: 'installer.zip' })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/\.exe/);
  });

  it('returns 400 when version is missing', async () => {
    const res = await POST(
      makePostRequest({ fileName: 'Owlette-Installer.exe' })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/version/i);
  });

  it('returns 401 when unauthorized', async () => {
    (requireAdmin as jest.Mock).mockRejectedValueOnce(
      new ApiAuthError(401, 'Unauthorized')
    );

    const res = await POST(
      makePostRequest({ version: '2.2.1', fileName: 'Owlette-Installer.exe' })
    );
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Unauthorized');
  });
});

describe('PUT /api/admin/installer/upload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (requireAdmin as jest.Mock).mockResolvedValue('test-admin');
    mockExists.mockResolvedValue([true]);
    mockGetMetadata.mockResolvedValue([{ size: '1048576' }]);
    mockGetSignedUrl.mockResolvedValue(['https://storage.example.com/signed-download']);
  });

  it('finalizes upload successfully', async () => {
    mockGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        version: '2.2.1',
        storagePath: 'agent-installers/versions/2.2.1/Owlette-Installer-v2.2.1.exe',
        userId: 'test-admin',
        releaseNotes: 'Bug fixes',
        setAsLatest: true,
        status: 'pending',
        expiresAt: Date.now() + 600000,
      }),
    });

    const res = await PUT(
      makePutRequest({ uploadId: 'test-upload-id', checksum_sha256: 'abc123' })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.version).toBe('2.2.1');
    expect(json.download_url).toBe('https://storage.example.com/signed-download');
    expect(json.file_size).toBe(1048576);
    // Should write version doc, latest doc, and update upload record
    expect(mockSet).toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('returns 404 when upload record not found', async () => {
    mockGet.mockResolvedValueOnce({ exists: false });

    const res = await PUT(makePutRequest({ uploadId: 'nonexistent' }));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toMatch(/upload record not found/i);
  });

  it('returns 409 when upload already completed', async () => {
    mockGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        status: 'completed',
        version: '2.2.1',
        storagePath: 'agent-installers/versions/2.2.1/installer.exe',
        expiresAt: Date.now() + 600000,
      }),
    });

    const res = await PUT(makePutRequest({ uploadId: 'already-done' }));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toMatch(/already completed/i);
  });

  it('returns 404 when file not in storage', async () => {
    mockGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        version: '2.2.1',
        storagePath: 'agent-installers/versions/2.2.1/installer.exe',
        userId: 'test-admin',
        setAsLatest: true,
        status: 'pending',
        expiresAt: Date.now() + 600000,
      }),
    });
    mockExists.mockResolvedValueOnce([false]);

    const res = await PUT(makePutRequest({ uploadId: 'missing-file' }));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toMatch(/not found in storage/i);
  });

  it('computes checksum server-side when client does not provide one', async () => {
    mockGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        version: '2.2.1',
        storagePath: 'agent-installers/versions/2.2.1/Owlette-Installer-v2.2.1.exe',
        userId: 'test-admin',
        releaseNotes: 'Bug fixes',
        setAsLatest: true,
        status: 'pending',
        expiresAt: Date.now() + 600000,
      }),
    });

    const res = await PUT(
      makePutRequest({ uploadId: 'test-upload-id' }) // no checksum_sha256
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.checksum_sha256).toBeTruthy();
    expect(json.checksum_sha256).toMatch(/^[a-f0-9]{64}$/); // valid SHA-256 hex
    expect(mockDownload).toHaveBeenCalled();
  });

  it('returns 400 when uploadId is missing', async () => {
    const res = await PUT(makePutRequest({}));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/uploadId/i);
  });
});
