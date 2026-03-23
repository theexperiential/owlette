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
              doc: () => ({
                get: mockGet,
                set: mockSet,
                update: mockUpdate,
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
}));

import { POST } from '@/app/api/admin/deployments/[deploymentId]/cancel/route';

describe('POST /api/admin/deployments/[deploymentId]/cancel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireAdminWithSiteAccess.mockResolvedValue({ userId: 'test-admin' });
  });

  it('sends cancel command and updates target status', async () => {
    mockGet.mockResolvedValueOnce({
      exists: true,
      id: 'deploy-100',
      data: () => ({
        targets: [
          { machineId: 'machine-1', status: 'in_progress' },
          { machineId: 'machine-2', status: 'pending' },
        ],
        status: 'in_progress',
      }),
    });

    const req = new NextRequest(
      'http://localhost/api/admin/deployments/deploy-100/cancel',
      {
        method: 'POST',
        body: JSON.stringify({
          siteId: 'site1',
          machineId: 'machine-1',
          installer_name: 'setup.exe',
        }),
        headers: { 'content-type': 'application/json' },
      }
    );

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.commandId).toBeDefined();
    expect(body.commandId).toContain('cancel_');

    // Should send cancel command via pending doc set with merge
    expect(mockSet).toHaveBeenCalled();
    const setCall = mockSet.mock.calls[0];
    const commandPayload = setCall[0];
    const commandKey = Object.keys(commandPayload)[0];
    expect(commandPayload[commandKey].type).toBe('cancel_installation');
    expect(commandPayload[commandKey].installer_name).toBe('setup.exe');
    expect(commandPayload[commandKey].deployment_id).toBe('deploy-100');
    expect(setCall[1]).toEqual({ merge: true });

    // Should update deployment targets with cancelled status
    expect(mockUpdate).toHaveBeenCalled();
    const updateCall = mockUpdate.mock.calls[0][0];
    expect(updateCall.targets).toBeDefined();
    const cancelledTarget = updateCall.targets.find(
      (t: any) => t.machineId === 'machine-1'
    );
    expect(cancelledTarget.status).toBe('cancelled');
    expect(cancelledTarget.cancelledAt).toBeDefined();
    // Other targets should remain unchanged
    const otherTarget = updateCall.targets.find(
      (t: any) => t.machineId === 'machine-2'
    );
    expect(otherTarget.status).toBe('pending');
  });

  it('returns 400 when siteId is missing', async () => {
    const req = new NextRequest(
      'http://localhost/api/admin/deployments/deploy-100/cancel',
      {
        method: 'POST',
        body: JSON.stringify({
          machineId: 'machine-1',
          installer_name: 'setup.exe',
        }),
        headers: { 'content-type': 'application/json' },
      }
    );

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Missing required fields');
  });

  it('returns 400 when machineId is missing', async () => {
    const req = new NextRequest(
      'http://localhost/api/admin/deployments/deploy-100/cancel',
      {
        method: 'POST',
        body: JSON.stringify({
          siteId: 'site1',
          installer_name: 'setup.exe',
        }),
        headers: { 'content-type': 'application/json' },
      }
    );

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Missing required fields');
  });

  it('returns 400 when installer_name is missing', async () => {
    const req = new NextRequest(
      'http://localhost/api/admin/deployments/deploy-100/cancel',
      {
        method: 'POST',
        body: JSON.stringify({
          siteId: 'site1',
          machineId: 'machine-1',
        }),
        headers: { 'content-type': 'application/json' },
      }
    );

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Missing required fields');
  });

  it('returns 404 when deployment not found', async () => {
    mockGet.mockResolvedValueOnce({ exists: false });

    const req = new NextRequest(
      'http://localhost/api/admin/deployments/deploy-missing/cancel',
      {
        method: 'POST',
        body: JSON.stringify({
          siteId: 'site1',
          machineId: 'machine-1',
          installer_name: 'setup.exe',
        }),
        headers: { 'content-type': 'application/json' },
      }
    );

    const res = await POST(req);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain('not found');
  });
});
