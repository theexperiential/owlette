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

import { GET, DELETE } from '@/app/api/admin/deployments/[deploymentId]/route';

describe('GET /api/admin/deployments/[deploymentId]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireAdminWithSiteAccess.mockResolvedValue({ userId: 'test-admin' });
  });

  it('returns full deployment with targets', async () => {
    mockGet.mockResolvedValueOnce({
      exists: true,
      id: 'deploy-123',
      data: () => ({
        name: 'Test Deployment',
        installer_name: 'setup.exe',
        installer_url: 'https://example.com/setup.exe',
        silent_flags: '/S',
        verify_path: 'C:/App/app.exe',
        targets: [
          { machineId: 'm1', status: 'completed' },
          { machineId: 'm2', status: 'in_progress' },
        ],
        createdAt: 1700000000000,
        completedAt: 1700000060000,
        status: 'partial',
      }),
    });

    const req = new NextRequest(
      'http://localhost/api/admin/deployments/deploy-123?siteId=site1'
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.deployment.id).toBe('deploy-123');
    expect(body.deployment.name).toBe('Test Deployment');
    expect(body.deployment.targets).toHaveLength(2);
    expect(body.deployment.verify_path).toBe('C:/App/app.exe');
    expect(body.deployment.completedAt).toBe(1700000060000);
  });

  it('returns 404 when deployment not found', async () => {
    mockGet.mockResolvedValueOnce({ exists: false });

    const req = new NextRequest(
      'http://localhost/api/admin/deployments/nonexistent?siteId=site1'
    );
    const res = await GET(req);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain('not found');
  });

  it('returns 400 when siteId is missing', async () => {
    const req = new NextRequest(
      'http://localhost/api/admin/deployments/deploy-123'
    );
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('siteId');
  });
});

describe('DELETE /api/admin/deployments/[deploymentId]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireAdminWithSiteAccess.mockResolvedValue({ userId: 'test-admin' });
  });

  it('deletes a deployment in terminal state', async () => {
    mockGet.mockResolvedValueOnce({
      exists: true,
      id: 'deploy-456',
      data: () => ({ status: 'completed' }),
    });

    const req = new NextRequest(
      'http://localhost/api/admin/deployments/deploy-456?siteId=site1',
      { method: 'DELETE' }
    );
    const res = await DELETE(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(mockDelete).toHaveBeenCalled();
  });

  it('returns 409 for non-terminal deployment', async () => {
    mockGet.mockResolvedValueOnce({
      exists: true,
      id: 'deploy-789',
      data: () => ({ status: 'in_progress' }),
    });

    const req = new NextRequest(
      'http://localhost/api/admin/deployments/deploy-789?siteId=site1',
      { method: 'DELETE' }
    );
    const res = await DELETE(req);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('in_progress');
  });

  it('returns 404 when deployment not found', async () => {
    mockGet.mockResolvedValueOnce({ exists: false });

    const req = new NextRequest(
      'http://localhost/api/admin/deployments/deploy-missing?siteId=site1',
      { method: 'DELETE' }
    );
    const res = await DELETE(req);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain('not found');
  });
});
