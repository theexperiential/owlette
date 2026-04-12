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

import { PATCH } from '@/app/api/admin/processes/[processId]/launch-mode/route';
import { ProcessConfigError } from '@/lib/processConfig.server';

describe('PATCH /api/admin/processes/[processId]/launch-mode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireAdminWithSiteAccess.mockResolvedValue({ userId: 'test-admin' });
    mockWithProcessConfig.mockResolvedValue({ success: true });
    mockUpdate.mockResolvedValue(undefined);
  });

  it('sets mode to always', async () => {
    mockWithProcessConfig.mockResolvedValueOnce({ success: true });

    const req = new NextRequest('http://localhost/api/admin/processes/p1/launch-mode', {
      method: 'PATCH',
      body: JSON.stringify({
        siteId: 's1',
        machineId: 'm1',
        mode: 'always',
      }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);
  });

  it('sets mode to off', async () => {
    mockWithProcessConfig.mockResolvedValueOnce({ success: true });

    const req = new NextRequest('http://localhost/api/admin/processes/p1/launch-mode', {
      method: 'PATCH',
      body: JSON.stringify({
        siteId: 's1',
        machineId: 'm1',
        mode: 'off',
      }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);
  });

  it('sets mode to scheduled with valid schedules', async () => {
    mockWithProcessConfig.mockResolvedValueOnce({ success: true });

    const req = new NextRequest('http://localhost/api/admin/processes/p1/launch-mode', {
      method: 'PATCH',
      body: JSON.stringify({
        siteId: 's1',
        machineId: 'm1',
        mode: 'scheduled',
        schedules: [
          { days: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00' },
        ],
      }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);
  });

  it('returns 400 for invalid mode', async () => {
    const req = new NextRequest('http://localhost/api/admin/processes/p1/launch-mode', {
      method: 'PATCH',
      body: JSON.stringify({
        siteId: 's1',
        machineId: 'm1',
        mode: 'invalid_mode',
      }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await PATCH(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when siteId/machineId missing', async () => {
    const req = new NextRequest('http://localhost/api/admin/processes/p1/launch-mode', {
      method: 'PATCH',
      body: JSON.stringify({
        mode: 'always',
      }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await PATCH(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 for scheduled mode without schedules', async () => {
    const req = new NextRequest('http://localhost/api/admin/processes/p1/launch-mode', {
      method: 'PATCH',
      body: JSON.stringify({
        siteId: 's1',
        machineId: 'm1',
        mode: 'scheduled',
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

    const req = new NextRequest('http://localhost/api/admin/processes/nonexistent/launch-mode', {
      method: 'PATCH',
      body: JSON.stringify({
        siteId: 's1',
        machineId: 'm1',
        mode: 'always',
      }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await PATCH(req);
    expect(res.status).toBe(404);
  });
});
