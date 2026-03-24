/** @jest-environment node */

import { ApiAuthError } from '@/lib/apiAuth.server';
import {
  mocks,
  mockDbFactory,
  querySnapshot,
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

import { GET, POST } from '@/app/api/admin/deployments/route';

/* ========================================================================== */
/*  GET /api/admin/deployments                                                */
/* ========================================================================== */
describe('GET /api/admin/deployments', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ userId: 'test-admin' });
  });

  it('returns 400 when siteId is missing', async () => {
    const req = createMockRequest('/api/admin/deployments');
    const res = await GET(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('siteId');
  });

  it('returns 401 when unauthorized', async () => {
    mocks.requireAdmin.mockRejectedValueOnce(new ApiAuthError(401, 'Unauthorized'));
    const req = createMockRequest('/api/admin/deployments?siteId=site1');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('returns deployments array on success', async () => {
    mocks.collectionGet.mockResolvedValueOnce(
      querySnapshot([
        {
          id: 'deploy-1',
          data: {
            name: 'VLC Media Player',
            installer_name: 'vlc-3.0.21-win64.exe',
            installer_url: 'https://get.videolan.org/vlc/3.0.21/win64/vlc-3.0.21-win64.exe',
            silent_flags: '/S',
            targets: [{ machineId: 'm1', status: 'completed' }],
            createdAt: 1700000000000,
            status: 'completed',
          },
        },
        {
          id: 'deploy-2',
          data: {
            name: '7-Zip Install',
            installer_name: '7z2408-x64.exe',
            installer_url: 'https://www.7-zip.org/a/7z2408-x64.exe',
            silent_flags: '/S',
            targets: [{ machineId: 'm2', status: 'pending' }],
            createdAt: 1700000001000,
            status: 'pending',
          },
        },
      ])
    );

    const req = createMockRequest('/api/admin/deployments?siteId=site1');
    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.deployments).toHaveLength(2);
    expect(body.deployments[0].id).toBe('deploy-1');
    expect(body.deployments[0].installer_name).toBe('vlc-3.0.21-win64.exe');
    expect(body.deployments[1].id).toBe('deploy-2');
    expect(body.deployments[1].installer_name).toBe('7z2408-x64.exe');
  });

  it('returns empty array when no deployments exist', async () => {
    mocks.collectionGet.mockResolvedValueOnce(querySnapshot([]));
    const req = createMockRequest('/api/admin/deployments?siteId=site1');
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect((await res.json()).deployments).toEqual([]);
  });

  it('respects limit query param', async () => {
    mocks.collectionGet.mockResolvedValueOnce(querySnapshot([]));
    const req = createMockRequest('/api/admin/deployments?siteId=site1&limit=5');
    await GET(req);
    expect(mocks.orderBy).toHaveBeenCalledWith('createdAt', 'desc');
    expect(mocks.limit).toHaveBeenCalledWith(5);
  });

  it('clamps limit to valid range (1-100)', async () => {
    mocks.collectionGet.mockResolvedValueOnce(querySnapshot([]));
    const req = createMockRequest('/api/admin/deployments?siteId=site1&limit=999');
    await GET(req);
    expect(mocks.limit).toHaveBeenCalledWith(100);
  });

  it('defaults missing fields to safe values', async () => {
    mocks.collectionGet.mockResolvedValueOnce(
      querySnapshot([{ id: 'deploy-bare', data: {} }])
    );
    const req = createMockRequest('/api/admin/deployments?siteId=site1');
    const res = await GET(req);
    const body = await res.json();
    const d = body.deployments[0];
    expect(d.name).toBe('Unnamed Deployment');
    expect(d.installer_name).toBe('');
    expect(d.targets).toEqual([]);
    expect(d.status).toBe('pending');
  });

  it('returns 500 when Firestore query fails', async () => {
    mocks.collectionGet.mockRejectedValueOnce(new Error('Firestore read error'));
    const req = createMockRequest('/api/admin/deployments?siteId=site1');
    const res = await GET(req);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain('Firestore read error');
  });
});

/* ========================================================================== */
/*  POST /api/admin/deployments                                               */
/* ========================================================================== */
describe('POST /api/admin/deployments', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ userId: 'test-admin' });
  });

  const validBody = {
    siteId: 'site1',
    name: 'Deploy 7-Zip',
    installer_name: '7z2408-x64.exe',
    installer_url: 'https://www.7-zip.org/a/7z2408-x64.exe',
    silent_flags: '/S',
    machineIds: ['machine-1', 'machine-2'],
  };

  it('creates deployment and returns deploymentId', async () => {
    const req = createMockRequest('/api/admin/deployments', {
      method: 'POST',
      body: validBody,
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.deploymentId).toMatch(/^deploy-\d+$/);

    // Deployment doc created
    expect(mocks.set).toHaveBeenCalled();
    const deploymentDoc = mocks.set.mock.calls[0][0];
    expect(deploymentDoc.name).toBe('Deploy 7-Zip');
    expect(deploymentDoc.installer_url).toBe('https://www.7-zip.org/a/7z2408-x64.exe');
    expect(deploymentDoc.targets).toHaveLength(2);
    expect(deploymentDoc.targets[0]).toEqual({ machineId: 'machine-1', status: 'pending' });

    // Status updated to in_progress after commands sent
    expect(mocks.update).toHaveBeenCalledWith({ status: 'in_progress' });
  });

  it('sends install_software command to each target machine', async () => {
    const req = createMockRequest('/api/admin/deployments', {
      method: 'POST',
      body: validBody,
    });
    await POST(req);

    // First call = deployment doc set, subsequent calls = command sets (with merge)
    const mergeCalls = mocks.set.mock.calls.filter(
      (call: any[]) => call[1]?.merge === true
    );
    expect(mergeCalls).toHaveLength(2); // one per machine

    const commandPayload = mergeCalls[0][0];
    const commandKey = Object.keys(commandPayload)[0];
    expect(commandPayload[commandKey].type).toBe('install_software');
    expect(commandPayload[commandKey].installer_name).toBe('7z2408-x64.exe');
    expect(commandPayload[commandKey].status).toBe('pending');
  });

  it('includes verify_path when provided', async () => {
    const req = createMockRequest('/api/admin/deployments', {
      method: 'POST',
      body: {
        ...validBody,
        verify_path: 'C:/Program Files/7-Zip/7z.exe',
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const deploymentDoc = mocks.set.mock.calls[0][0];
    expect(deploymentDoc.verify_path).toBe('C:/Program Files/7-Zip/7z.exe');
  });

  it('returns 400 when required fields are missing', async () => {
    const req = createMockRequest('/api/admin/deployments', {
      method: 'POST',
      body: { siteId: 'site1', name: 'Incomplete' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Missing required fields');
  });

  it('returns 400 when machineIds is empty', async () => {
    const req = createMockRequest('/api/admin/deployments', {
      method: 'POST',
      body: { ...validBody, machineIds: [] },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('machineIds');
  });

  it('returns 400 when machineIds is not an array', async () => {
    const req = createMockRequest('/api/admin/deployments', {
      method: 'POST',
      body: { ...validBody, machineIds: 'not-an-array' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('machineIds');
  });

  it('returns 401 when unauthorized', async () => {
    mocks.requireAdmin.mockRejectedValueOnce(new ApiAuthError(401, 'Unauthorized'));
    const req = createMockRequest('/api/admin/deployments', {
      method: 'POST',
      body: validBody,
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 400 when installer_url is not HTTPS', async () => {
    const req = createMockRequest('/api/admin/deployments', {
      method: 'POST',
      body: { ...validBody, installer_url: 'http://example.com/setup.exe' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('HTTPS');
  });

  it('returns 400 when installer_url is not a valid URL', async () => {
    const req = createMockRequest('/api/admin/deployments', {
      method: 'POST',
      body: { ...validBody, installer_url: 'not-a-url' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('valid URL');
  });

  it('returns 400 when installer_url uses file:// protocol', async () => {
    const req = createMockRequest('/api/admin/deployments', {
      method: 'POST',
      body: { ...validBody, installer_url: 'file:///C:/malicious.exe' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('HTTPS');
  });

  it('returns 500 when Firestore write fails', async () => {
    mocks.set.mockRejectedValueOnce(new Error('Firestore unavailable'));
    const req = createMockRequest('/api/admin/deployments', {
      method: 'POST',
      body: validBody,
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain('Firestore unavailable');
  });
});
