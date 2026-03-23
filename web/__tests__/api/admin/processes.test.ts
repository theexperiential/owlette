/** @jest-environment node */

import { NextRequest } from 'next/server';
import { ApiAuthError } from '@/lib/apiAuth.server';

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
    runTransaction: jest.fn(async (fn: Function) => {
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

import { GET, POST } from '@/app/api/admin/processes/route';

describe('GET /api/admin/processes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireAdminWithSiteAccess.mockResolvedValue({ userId: 'test-admin' });
  });

  it('returns 400 when siteId is missing', async () => {
    const req = new NextRequest('http://localhost/api/admin/processes?machineId=m1');
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it('returns 400 when machineId is missing', async () => {
    const req = new NextRequest('http://localhost/api/admin/processes?siteId=s1');
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it('returns merged processes on success', async () => {
    const configProcesses = [
      { id: 'p1', name: 'Process1', exe_path: 'C:/app.exe' },
      { id: 'p2', name: 'Process2', exe_path: 'C:/app2.exe' },
    ];
    const statusProcesses = [
      { id: 'p1', status: 'running', cpu: 5.2 },
    ];

    mockGet
      .mockResolvedValueOnce({
        exists: true,
        data: () => ({ processes: configProcesses }),
      })
      .mockResolvedValueOnce({
        exists: true,
        data: () => ({ metrics: { processes: statusProcesses } }),
      });

    const req = new NextRequest('http://localhost/api/admin/processes?siteId=s1&machineId=m1');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.processes)).toBe(true);
    expect(body.processes.length).toBe(2);
  });

  it('returns empty array when config doc does not exist', async () => {
    mockGet
      .mockResolvedValueOnce({ exists: false, data: () => null })
      .mockResolvedValueOnce({ exists: false, data: () => null });

    const req = new NextRequest('http://localhost/api/admin/processes?siteId=s1&machineId=m1');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processes).toEqual([]);
  });

  it('returns processes with unknown status when status doc does not exist', async () => {
    const configProcesses = [
      { id: 'p1', name: 'Process1', exe_path: 'C:/app.exe' },
    ];

    mockGet
      .mockResolvedValueOnce({
        exists: true,
        data: () => ({ processes: configProcesses }),
      })
      .mockResolvedValueOnce({ exists: false, data: () => null });

    const req = new NextRequest('http://localhost/api/admin/processes?siteId=s1&machineId=m1');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processes.length).toBe(1);
    expect(body.processes[0].status).toBe('unknown');
  });

  it('returns 401 when auth fails', async () => {
    mockRequireAdminWithSiteAccess.mockRejectedValueOnce(
      new ApiAuthError(401, 'Unauthorized')
    );

    const req = new NextRequest('http://localhost/api/admin/processes?siteId=s1&machineId=m1');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/admin/processes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireAdminWithSiteAccess.mockResolvedValue({ userId: 'test-admin' });
    mockWithProcessConfig.mockResolvedValue({ success: true });
  });

  it('creates a process with all fields', async () => {
    mockWithProcessConfig.mockResolvedValueOnce({ processId: 'new-p1' });

    const req = new NextRequest('http://localhost/api/admin/processes', {
      method: 'POST',
      body: JSON.stringify({
        siteId: 's1',
        machineId: 'm1',
        name: 'NewProcess',
        exe_path: 'C:/new.exe',
        launch_mode: 'always',
      }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it('returns 400 when name is missing', async () => {
    const req = new NextRequest('http://localhost/api/admin/processes', {
      method: 'POST',
      body: JSON.stringify({
        siteId: 's1',
        machineId: 'm1',
        exe_path: 'C:/app.exe',
      }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when exe_path is missing', async () => {
    const req = new NextRequest('http://localhost/api/admin/processes', {
      method: 'POST',
      body: JSON.stringify({
        siteId: 's1',
        machineId: 'm1',
        name: 'SomeProcess',
      }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when siteId is missing', async () => {
    const req = new NextRequest('http://localhost/api/admin/processes', {
      method: 'POST',
      body: JSON.stringify({
        machineId: 'm1',
        name: 'SomeProcess',
        exe_path: 'C:/app.exe',
      }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns processId in response', async () => {
    mockWithProcessConfig.mockResolvedValueOnce({ processId: 'generated-id-123' });

    const req = new NextRequest('http://localhost/api/admin/processes', {
      method: 'POST',
      body: JSON.stringify({
        siteId: 's1',
        machineId: 'm1',
        name: 'NewProcess',
        exe_path: 'C:/new.exe',
      }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.processId).toBeDefined();
  });

  it('returns 401 when unauthorized', async () => {
    mockRequireAdminWithSiteAccess.mockRejectedValueOnce(
      new ApiAuthError(401, 'Unauthorized')
    );

    const req = new NextRequest('http://localhost/api/admin/processes', {
      method: 'POST',
      body: JSON.stringify({
        siteId: 's1',
        machineId: 'm1',
        name: 'NewProcess',
        exe_path: 'C:/new.exe',
      }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });
});
