/** @jest-environment node */

import {
  mocks,
  mockDbFactory,
  docSnapshot,
} from '../helpers/firestore-mock';
import { createMockRequest } from '../helpers/utils';

// --- jest.mock() calls (hoisted by Jest — must be top-level) ---
jest.mock('@/lib/withRateLimit', () => ({ withRateLimit: (h: any) => h }));
jest.mock('@/lib/logger', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  __esModule: true,
}));
jest.mock('@/lib/apiHelpers.server', () => ({
  requireAdminWithSiteAccess: (...a: any[]) => mocks.requireAdmin(...a),
  getRouteParam: jest.fn((req: any, idx: number) => {
    const s = new URL(req.url).pathname.split('/').filter(Boolean);
    return s[idx];
  }),
}));
jest.mock('@/lib/firebase-admin', () => ({ getAdminDb: () => mockDbFactory() }));

import { GET, DELETE } from '@/app/api/admin/deployments/[deploymentId]/route';

/* ========================================================================== */
/*  GET /api/admin/deployments/[deploymentId]                                 */
/* ========================================================================== */
describe('GET /api/admin/deployments/[deploymentId]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ userId: 'test-admin' });
  });

  it('returns full deployment with targets', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot('deploy-123', {
        name: 'VLC Deploy',
        installer_name: 'vlc-3.0.21-win64.exe',
        installer_url: 'https://get.videolan.org/vlc/3.0.21/win64/vlc-3.0.21-win64.exe',
        silent_flags: '/S',
        verify_path: 'C:/Program Files/VideoLAN/VLC/vlc.exe',
        targets: [
          { machineId: 'm1', status: 'completed' },
          { machineId: 'm2', status: 'in_progress' },
        ],
        createdAt: 1700000000000,
        completedAt: 1700000060000,
        status: 'partial',
      })
    );

    const req = createMockRequest(
      '/api/admin/deployments/deploy-123?siteId=site1'
    );
    const res = await GET(req);
    expect(res.status).toBe(200);

    const { deployment } = await res.json();
    expect(deployment.id).toBe('deploy-123');
    expect(deployment.name).toBe('VLC Deploy');
    expect(deployment.targets).toHaveLength(2);
    expect(deployment.verify_path).toBe('C:/Program Files/VideoLAN/VLC/vlc.exe');
    expect(deployment.completedAt).toBe(1700000060000);
    expect(deployment.status).toBe('partial');
  });

  it('returns 404 when deployment not found', async () => {
    mocks.get.mockResolvedValueOnce(docSnapshot('nonexistent', null));
    const req = createMockRequest(
      '/api/admin/deployments/nonexistent?siteId=site1'
    );
    const res = await GET(req);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('not found');
  });

  it('returns 400 when siteId is missing', async () => {
    const req = createMockRequest('/api/admin/deployments/deploy-123');
    const res = await GET(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('siteId');
  });

  it('defaults missing fields gracefully', async () => {
    mocks.get.mockResolvedValueOnce(docSnapshot('deploy-bare', {}));
    const req = createMockRequest(
      '/api/admin/deployments/deploy-bare?siteId=site1'
    );
    const res = await GET(req);
    const { deployment } = await res.json();
    expect(deployment.name).toBe('Unnamed Deployment');
    expect(deployment.installer_name).toBe('');
    expect(deployment.targets).toEqual([]);
    expect(deployment.status).toBe('pending');
    expect(deployment.verify_path).toBeUndefined();
    expect(deployment.completedAt).toBeUndefined();
  });
});

/* ========================================================================== */
/*  DELETE /api/admin/deployments/[deploymentId]                              */
/* ========================================================================== */
describe('DELETE /api/admin/deployments/[deploymentId]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ userId: 'test-admin' });
  });

  const terminalStatuses = ['completed', 'failed', 'partial', 'cancelled', 'uninstalled'];

  for (const status of terminalStatuses) {
    it(`allows deletion when status is "${status}"`, async () => {
      mocks.get.mockResolvedValueOnce(docSnapshot('deploy-ok', { status }));
      const req = createMockRequest(
        '/api/admin/deployments/deploy-ok?siteId=site1',
        { method: 'DELETE' }
      );
      const res = await DELETE(req);
      expect(res.status).toBe(200);
      expect(mocks.del).toHaveBeenCalled();
    });
  }

  const nonTerminalStatuses = ['pending', 'in_progress'];

  for (const status of nonTerminalStatuses) {
    it(`returns 409 when status is "${status}"`, async () => {
      mocks.get.mockResolvedValueOnce(docSnapshot('deploy-active', { status }));
      const req = createMockRequest(
        '/api/admin/deployments/deploy-active?siteId=site1',
        { method: 'DELETE' }
      );
      const res = await DELETE(req);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toContain(status);
    });
  }

  it('returns 404 when deployment not found', async () => {
    mocks.get.mockResolvedValueOnce(docSnapshot('missing', null));
    const req = createMockRequest(
      '/api/admin/deployments/missing?siteId=site1',
      { method: 'DELETE' }
    );
    const res = await DELETE(req);
    expect(res.status).toBe(404);
  });

  it('returns 400 when siteId is missing', async () => {
    const req = createMockRequest('/api/admin/deployments/deploy-123', {
      method: 'DELETE',
    });
    const res = await DELETE(req);
    expect(res.status).toBe(400);
  });
});
