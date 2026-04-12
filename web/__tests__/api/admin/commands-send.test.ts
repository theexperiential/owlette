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
    assertUserHasSiteAccess: jest.fn().mockResolvedValue({ siteId: 's1', siteData: {} }),
    ApiAuthError: _ApiAuthError,
  };
});

const { requireAdminOrIdToken, assertUserHasSiteAccess, ApiAuthError } =
  jest.requireMock('@/lib/apiAuth.server');

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
              doc: (_subSubId?: string) => ({
                get: mockGet,
                set: mockSet,
                update: mockUpdate,
                delete: mockDelete,
              }),
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

import { POST } from '@/app/api/admin/commands/send/route';

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/admin/commands/send', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/admin/commands/send', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (requireAdminOrIdToken as jest.Mock).mockResolvedValue('test-admin');
    (assertUserHasSiteAccess as jest.Mock).mockResolvedValue({ siteId: 's1', siteData: {} });
  });

  it('sends command and returns immediately when wait=false', async () => {
    const res = await POST(
      makeRequest({
        siteId: 's1',
        machineId: 'm1',
        command: 'restart_process',
        data: { process_name: 'MyApp.exe' },
        wait: false,
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.commandId).toBeDefined();
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        [json.commandId]: expect.objectContaining({
          type: 'restart_process',
          process_name: 'MyApp.exe',
          status: 'pending',
        }),
      }),
      { merge: true }
    );
  });

  it('returns 400 when siteId is missing', async () => {
    const res = await POST(
      makeRequest({ machineId: 'm1', command: 'restart_process' })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/siteId/i);
  });

  it('returns 400 when command is missing', async () => {
    const res = await POST(
      makeRequest({ siteId: 's1', machineId: 'm1' })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/command/i);
  });

  it('returns 400 when machineId is missing', async () => {
    const res = await POST(
      makeRequest({ siteId: 's1', command: 'restart_process' })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/machineId/i);
  });

  it('returns commandId in response', async () => {
    const res = await POST(
      makeRequest({
        siteId: 's1',
        machineId: 'm1',
        command: 'reboot_machine',
        wait: false,
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(typeof json.commandId).toBe('string');
    expect(json.commandId.length).toBeGreaterThan(0);
  });

  it('returns 401 when unauthorized', async () => {
    (requireAdminOrIdToken as jest.Mock).mockRejectedValueOnce(
      new ApiAuthError(401, 'Unauthorized')
    );

    const res = await POST(
      makeRequest({
        siteId: 's1',
        machineId: 'm1',
        command: 'restart_process',
      })
    );
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Unauthorized');
  });
});
