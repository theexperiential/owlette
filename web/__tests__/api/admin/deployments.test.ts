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

import { GET, POST } from '@/app/api/admin/deployments/route';

describe('GET /api/admin/deployments', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireAdminWithSiteAccess.mockResolvedValue({ userId: 'test-admin' });
  });

  it('returns 400 when siteId is missing', async () => {
    const req = new NextRequest('http://localhost/api/admin/deployments');
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('siteId');
  });

  it('returns deployments array on success', async () => {
    mockCollectionGet.mockResolvedValueOnce({
      docs: [
        {
          id: 'deploy-1',
          data: () => ({
            name: 'Test Deploy',
            installer_name: 'setup.exe',
            installer_url: 'https://example.com/setup.exe',
            silent_flags: '/S',
            targets: [{ machineId: 'm1', status: 'completed' }],
            createdAt: 1700000000000,
            status: 'completed',
          }),
        },
        {
          id: 'deploy-2',
          data: () => ({
            name: 'Another Deploy',
            installer_name: 'install.msi',
            installer_url: 'https://example.com/install.msi',
            silent_flags: '/quiet',
            targets: [{ machineId: 'm2', status: 'pending' }],
            createdAt: 1700000001000,
            status: 'pending',
          }),
        },
      ],
    });

    const req = new NextRequest('http://localhost/api/admin/deployments?siteId=site1');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.deployments)).toBe(true);
    expect(body.deployments.length).toBe(2);
    expect(body.deployments[0].id).toBe('deploy-1');
    expect(body.deployments[0].name).toBe('Test Deploy');
    expect(body.deployments[1].id).toBe('deploy-2');
  });

  it('returns empty array when no deployments exist', async () => {
    mockCollectionGet.mockResolvedValueOnce({ docs: [] });

    const req = new NextRequest('http://localhost/api/admin/deployments?siteId=site1');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.deployments).toEqual([]);
  });

  it('respects limit query param', async () => {
    mockCollectionGet.mockResolvedValueOnce({ docs: [] });

    const req = new NextRequest('http://localhost/api/admin/deployments?siteId=site1&limit=5');
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(mockOrderBy).toHaveBeenCalledWith('createdAt', 'desc');
    expect(mockLimit).toHaveBeenCalledWith(5);
  });

  it('returns 401 when unauthorized', async () => {
    mockRequireAdminWithSiteAccess.mockRejectedValueOnce(
      new ApiAuthError(401, 'Unauthorized')
    );

    const req = new NextRequest('http://localhost/api/admin/deployments?siteId=site1');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/admin/deployments', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireAdminWithSiteAccess.mockResolvedValue({ userId: 'test-admin' });
  });

  it('creates deployment and returns deploymentId', async () => {
    const req = new NextRequest('http://localhost/api/admin/deployments', {
      method: 'POST',
      body: JSON.stringify({
        siteId: 'site1',
        name: 'New Deployment',
        installer_name: 'setup.exe',
        installer_url: 'https://example.com/setup.exe',
        silent_flags: '/S',
        machineIds: ['machine-1', 'machine-2'],
      }),
      headers: { 'content-type': 'application/json' },
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.deploymentId).toBeDefined();
    expect(body.deploymentId).toContain('deploy-');
    // Should create deployment doc
    expect(mockSet).toHaveBeenCalled();
    // Should update status to in_progress
    expect(mockUpdate).toHaveBeenCalledWith({ status: 'in_progress' });
  });

  it('returns 400 when required fields are missing', async () => {
    const req = new NextRequest('http://localhost/api/admin/deployments', {
      method: 'POST',
      body: JSON.stringify({
        siteId: 'site1',
        name: 'Incomplete Deploy',
        // missing installer_name, installer_url, silent_flags
        machineIds: ['machine-1'],
      }),
      headers: { 'content-type': 'application/json' },
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Missing required fields');
  });

  it('returns 400 when machineIds is empty', async () => {
    const req = new NextRequest('http://localhost/api/admin/deployments', {
      method: 'POST',
      body: JSON.stringify({
        siteId: 'site1',
        name: 'Deploy',
        installer_name: 'setup.exe',
        installer_url: 'https://example.com/setup.exe',
        silent_flags: '/S',
        machineIds: [],
      }),
      headers: { 'content-type': 'application/json' },
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('machineIds');
  });

  it('returns 400 when machineIds is not an array', async () => {
    const req = new NextRequest('http://localhost/api/admin/deployments', {
      method: 'POST',
      body: JSON.stringify({
        siteId: 'site1',
        name: 'Deploy',
        installer_name: 'setup.exe',
        installer_url: 'https://example.com/setup.exe',
        silent_flags: '/S',
        machineIds: 'not-an-array',
      }),
      headers: { 'content-type': 'application/json' },
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('machineIds');
  });

  it('includes verify_path when provided', async () => {
    const req = new NextRequest('http://localhost/api/admin/deployments', {
      method: 'POST',
      body: JSON.stringify({
        siteId: 'site1',
        name: 'Deploy with verify',
        installer_name: 'setup.exe',
        installer_url: 'https://example.com/setup.exe',
        silent_flags: '/S',
        verify_path: 'C:/Program Files/App/app.exe',
        machineIds: ['machine-1'],
      }),
      headers: { 'content-type': 'application/json' },
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    // verify_path should be included in the deployment doc set call
    const setCall = mockSet.mock.calls[0][0];
    expect(setCall.verify_path).toBe('C:/Program Files/App/app.exe');
  });
});
