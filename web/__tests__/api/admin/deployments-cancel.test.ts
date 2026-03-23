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

import { POST } from '@/app/api/admin/deployments/[deploymentId]/cancel/route';

describe('POST /api/admin/deployments/[deploymentId]/cancel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ userId: 'test-admin' });
  });

  it('sends cancel command and updates target status', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot('deploy-100', {
        targets: [
          { machineId: 'machine-1', status: 'in_progress' },
          { machineId: 'machine-2', status: 'pending' },
        ],
        status: 'in_progress',
      })
    );

    const req = createMockRequest(
      '/api/admin/deployments/deploy-100/cancel',
      {
        method: 'POST',
        body: {
          siteId: 'site1',
          machineId: 'machine-1',
          installer_name: 'vlc-3.0.21-win64.exe',
        },
      }
    );

    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.commandId).toMatch(/^cancel_\d+_machine_1$/);

    // Verify cancel_installation command was sent via set with merge
    const mergeCalls = mocks.set.mock.calls.filter(
      (call: any[]) => call[1]?.merge === true
    );
    expect(mergeCalls).toHaveLength(1);

    const commandPayload = mergeCalls[0][0];
    const commandKey = Object.keys(commandPayload)[0];
    expect(commandPayload[commandKey].type).toBe('cancel_installation');
    expect(commandPayload[commandKey].installer_name).toBe('vlc-3.0.21-win64.exe');
    expect(commandPayload[commandKey].deployment_id).toBe('deploy-100');

    // Verify target status updated
    const updateCall = mocks.update.mock.calls[0][0];
    const cancelledTarget = updateCall.targets.find(
      (t: any) => t.machineId === 'machine-1'
    );
    expect(cancelledTarget.status).toBe('cancelled');
    expect(cancelledTarget.cancelledAt).toBeDefined();

    // Other targets unchanged — deployment stays in_progress (not all terminal)
    const otherTarget = updateCall.targets.find(
      (t: any) => t.machineId === 'machine-2'
    );
    expect(otherTarget.status).toBe('pending');
    expect(updateCall.status).toBeUndefined(); // not all terminal yet
  });

  it('sets deployment status to cancelled when all targets are cancelled', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot('deploy-200', {
        targets: [
          { machineId: 'machine-1', status: 'in_progress' },
        ],
        status: 'in_progress',
      })
    );

    const req = createMockRequest(
      '/api/admin/deployments/deploy-200/cancel',
      {
        method: 'POST',
        body: {
          siteId: 'site1',
          machineId: 'machine-1',
          installer_name: 'setup.exe',
        },
      }
    );

    const res = await POST(req);
    expect(res.status).toBe(200);

    const updateCall = mocks.update.mock.calls[0][0];
    expect(updateCall.status).toBe('cancelled');
    expect(updateCall.completedAt).toBeDefined();
  });

  it('sets deployment status to partial when targets have mixed terminal states', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot('deploy-300', {
        targets: [
          { machineId: 'machine-1', status: 'in_progress' },
          { machineId: 'machine-2', status: 'completed' },
        ],
        status: 'in_progress',
      })
    );

    const req = createMockRequest(
      '/api/admin/deployments/deploy-300/cancel',
      {
        method: 'POST',
        body: {
          siteId: 'site1',
          machineId: 'machine-1',
          installer_name: 'setup.exe',
        },
      }
    );

    const res = await POST(req);
    expect(res.status).toBe(200);

    const updateCall = mocks.update.mock.calls[0][0];
    expect(updateCall.status).toBe('partial');
    expect(updateCall.completedAt).toBeDefined();
  });

  it('returns 400 when siteId is missing', async () => {
    const req = createMockRequest(
      '/api/admin/deployments/deploy-100/cancel',
      {
        method: 'POST',
        body: { machineId: 'machine-1', installer_name: 'setup.exe' },
      }
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Missing required fields');
  });

  it('returns 400 when machineId is missing', async () => {
    const req = createMockRequest(
      '/api/admin/deployments/deploy-100/cancel',
      {
        method: 'POST',
        body: { siteId: 'site1', installer_name: 'setup.exe' },
      }
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Missing required fields');
  });

  it('returns 400 when installer_name is missing', async () => {
    const req = createMockRequest(
      '/api/admin/deployments/deploy-100/cancel',
      {
        method: 'POST',
        body: { siteId: 'site1', machineId: 'machine-1' },
      }
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Missing required fields');
  });

  it('returns 404 when deployment not found', async () => {
    mocks.get.mockResolvedValueOnce(docSnapshot('missing', null));
    const req = createMockRequest(
      '/api/admin/deployments/missing/cancel',
      {
        method: 'POST',
        body: {
          siteId: 'site1',
          machineId: 'machine-1',
          installer_name: 'setup.exe',
        },
      }
    );
    const res = await POST(req);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('not found');
  });
});
