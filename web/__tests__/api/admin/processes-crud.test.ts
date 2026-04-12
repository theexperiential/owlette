/** @jest-environment node */

import { NextRequest } from 'next/server';

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (handler: any) => handler,
}));
jest.mock('@/lib/logger', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  __esModule: true,
}));

const mockRequireAdminWithSiteAccess = jest.fn().mockResolvedValue({ userId: 'test-admin' });
jest.mock('@/lib/apiHelpers.server', () => ({
  requireAdminWithSiteAccess: (...args: any[]) => mockRequireAdminWithSiteAccess(...args),
  getRouteParam: jest.fn((req: any, idx: number) => {
    const segments = new URL(req.url).pathname.split('/').filter(Boolean);
    return segments[idx];
  }),
}));

const mockGet = jest.fn();
const mockSet = jest.fn().mockResolvedValue(undefined);
const mockUpdate = jest.fn().mockResolvedValue(undefined);
const mockDelete = jest.fn().mockResolvedValue(undefined);

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: () => ({
      doc: () => ({
        get: mockGet,
        set: mockSet,
        update: mockUpdate,
        delete: mockDelete,
        collection: () => ({
          doc: () => ({
            get: mockGet,
            set: mockSet,
            update: mockUpdate,
            delete: mockDelete,
          }),
        }),
      }),
    }),
    runTransaction: jest.fn(async (fn: (tx: unknown) => unknown) => {
      return fn({ get: mockGet, set: mockSet, update: mockUpdate, delete: mockDelete });
    }),
  }),
}));

const mockWithProcessConfig = jest.fn();
jest.mock('@/lib/processConfig.server', () => ({
  withProcessConfig: (...args: any[]) => mockWithProcessConfig(...args),
  ProcessConfigError: class extends Error {
    status: number;
    constructor(s: number, m: string) {
      super(m);
      this.status = s;
    }
  },
}));

import { PATCH, DELETE } from '@/app/api/admin/processes/[processId]/route';
import { ProcessConfigError } from '@/lib/processConfig.server';
import { ApiAuthError } from '@/lib/apiAuth.server';

describe('PATCH /api/admin/processes/[processId]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireAdminWithSiteAccess.mockResolvedValue({ userId: 'test-admin' });
    mockWithProcessConfig.mockResolvedValue({ success: true });
  });

  it('updates process fields successfully', async () => {
    mockWithProcessConfig.mockResolvedValueOnce({ success: true });

    const req = new NextRequest('http://localhost/api/admin/processes/p1', {
      method: 'PATCH',
      body: JSON.stringify({
        siteId: 's1',
        machineId: 'm1',
        name: 'UpdatedName',
        exe_path: 'C:/updated.exe',
      }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);
  });

  it('returns 400 when no fields to update', async () => {
    const req = new NextRequest('http://localhost/api/admin/processes/p1', {
      method: 'PATCH',
      body: JSON.stringify({
        siteId: 's1',
        machineId: 'm1',
      }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await PATCH(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when siteId/machineId missing', async () => {
    const req = new NextRequest('http://localhost/api/admin/processes/p1', {
      method: 'PATCH',
      body: JSON.stringify({
        name: 'UpdatedName',
      }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await PATCH(req);
    expect(res.status).toBe(400);
  });

  it('returns 404 when process not found', async () => {
    mockWithProcessConfig.mockRejectedValueOnce(
      new ProcessConfigError(404, 'Process not found')
    );

    const req = new NextRequest('http://localhost/api/admin/processes/nonexistent', {
      method: 'PATCH',
      body: JSON.stringify({
        siteId: 's1',
        machineId: 'm1',
        name: 'UpdatedName',
      }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await PATCH(req);
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/admin/processes/[processId]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireAdminWithSiteAccess.mockResolvedValue({ userId: 'test-admin' });
    mockWithProcessConfig.mockResolvedValue({ success: true });
  });

  it('deletes process successfully', async () => {
    mockWithProcessConfig.mockResolvedValueOnce({ success: true });

    const req = new NextRequest(
      'http://localhost/api/admin/processes/p1?siteId=s1&machineId=m1',
      { method: 'DELETE' }
    );
    const res = await DELETE(req);
    expect(res.status).toBe(200);
  });

  it('returns 400 when query params missing', async () => {
    const req = new NextRequest('http://localhost/api/admin/processes/p1', {
      method: 'DELETE',
    });
    const res = await DELETE(req);
    expect(res.status).toBe(400);
  });

  it('returns 404 when process not found', async () => {
    mockWithProcessConfig.mockRejectedValueOnce(
      new ProcessConfigError(404, 'Process not found')
    );

    const req = new NextRequest(
      'http://localhost/api/admin/processes/nonexistent?siteId=s1&machineId=m1',
      { method: 'DELETE' }
    );
    const res = await DELETE(req);
    expect(res.status).toBe(404);
  });

  it('returns 401 when unauthorized', async () => {
    mockRequireAdminWithSiteAccess.mockRejectedValueOnce(
      new ApiAuthError(401, 'Unauthorized')
    );

    const req = new NextRequest(
      'http://localhost/api/admin/processes/p1?siteId=s1&machineId=m1',
      { method: 'DELETE' }
    );
    const res = await DELETE(req);
    expect(res.status).toBe(401);
  });
});
