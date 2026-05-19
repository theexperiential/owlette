/** @jest-environment node */

/**
 * Cross-machine token rejection tests for the agent endpoints.
 *
 * Verifies the `machine_id_mismatch` 403 short-circuit added in the wave 1-3
 * hardening pass. The endpoints validate the bearer token's `machine_id`
 * claim against the body's machineId so a compromised machine A token can't
 * be used to write/upload against machine B.
 */

import { createMockRequest } from '../helpers/utils';

const mockVerifyIdToken = jest.fn();

jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({
    verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args),
  }),
  getAdminDb: () => ({
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: false, data: () => undefined }),
        set: async () => undefined,
        update: async () => undefined,
        collection: () => ({
          add: async () => undefined,
          get: async () => ({ docs: [], size: 0 }),
        }),
      }),
    }),
  }),
  getAdminStorage: () => ({
    bucket: () => ({ name: 'bucket', file: () => ({}) }),
  }),
}));
jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (h: unknown) => h,
}));
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

import { POST as screenshotPOST } from '@/app/api/agent/screenshot/route';
import { POST as alertPOST } from '@/app/api/agent/alert/route';

beforeEach(() => {
  jest.clearAllMocks();
  process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'bucket.example';
});

describe('POST /api/agent/screenshot — cross-machine token rejection', () => {
  it('returns 403 machine_id_mismatch when token machine_id != body machineId', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({
      role: 'agent',
      site_id: 'site-a',
      machine_id: 'attacker-machine',
    });

    const req = createMockRequest('http://localhost/api/agent/screenshot', {
      method: 'POST',
      headers: { Authorization: 'Bearer fake-token' },
      body: {
        siteId: 'site-a',
        machineId: 'victim-machine',
        screenshot: 'aGVsbG8=', // "hello" base64
      },
    });

    const res = await screenshotPOST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('machine_id_mismatch');
  });

  it('returns 403 site_id mismatch when site_id claim differs (defense-in-depth)', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({
      role: 'agent',
      site_id: 'site-attacker',
      machine_id: 'machine-1',
    });

    const req = createMockRequest('http://localhost/api/agent/screenshot', {
      method: 'POST',
      headers: { Authorization: 'Bearer fake-token' },
      body: {
        siteId: 'site-victim',
        machineId: 'machine-1',
        screenshot: 'aGVsbG8=',
      },
    });

    const res = await screenshotPOST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/site_id mismatch/i);
  });
});

describe('POST /api/agent/alert — cross-machine token rejection', () => {
  it('returns 403 machine_id_mismatch when token machine_id != body machineId', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({
      role: 'agent',
      site_id: 'site-a',
      machine_id: 'attacker-machine',
    });

    const req = createMockRequest('http://localhost/api/agent/alert', {
      method: 'POST',
      headers: { Authorization: 'Bearer fake-token' },
      body: {
        siteId: 'site-a',
        machineId: 'victim-machine',
        errorCode: 'EXAMPLE',
        errorMessage: 'whatever',
        agentVersion: '2.11.3',
      },
    });

    const res = await alertPOST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('machine_id_mismatch');
  });

  it('returns 403 site_id mismatch with mismatched site claim', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({
      role: 'agent',
      site_id: 'site-attacker',
      machine_id: 'machine-1',
    });

    const req = createMockRequest('http://localhost/api/agent/alert', {
      method: 'POST',
      headers: { Authorization: 'Bearer fake-token' },
      body: {
        siteId: 'site-victim',
        machineId: 'machine-1',
        errorCode: 'EXAMPLE',
        errorMessage: 'whatever',
        agentVersion: '2.11.3',
      },
    });

    const res = await alertPOST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/site_id mismatch/i);
  });
});
