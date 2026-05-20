/** @jest-environment node */

const mockGet = jest.fn();
const mockGetAdminDb = jest.fn();

const mockDb = {
  collection: jest.fn(() => ({
    doc: jest.fn(() => ({ get: mockGet })),
  })),
};

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: (...args: unknown[]) => mockGetAdminDb(...args),
}));

import { GET } from '@/app/api/health/route';

describe('GET /api/health', () => {
  const originalEnv = {
    RAILWAY_PUBLIC_DOMAIN: process.env.RAILWAY_PUBLIC_DOMAIN,
    VERCEL: process.env.VERCEL,
    VERCEL_REGION: process.env.VERCEL_REGION,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAdminDb.mockReturnValue(mockDb);
    mockGet.mockResolvedValue({ exists: true });
    delete process.env.RAILWAY_PUBLIC_DOMAIN;
    delete process.env.VERCEL;
    delete process.env.VERCEL_REGION;
  });

  afterAll(() => {
    process.env.RAILWAY_PUBLIC_DOMAIN = originalEnv.RAILWAY_PUBLIC_DOMAIN;
    process.env.VERCEL = originalEnv.VERCEL;
    process.env.VERCEL_REGION = originalEnv.VERCEL_REGION;
  });

  it('returns 200 and ok:true when firestore is reachable', async () => {
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.latency_ms).toBe('number');
    expect(typeof body.checked_at).toBe('string');
    expect(res.headers.get('Cache-Control')).toBe('no-store, max-age=0');
  });

  it('returns 200 even when the heartbeat doc does not exist (read still succeeds)', async () => {
    mockGet.mockResolvedValueOnce({ exists: false });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it('returns 503 and ok:false when the firestore read rejects', async () => {
    mockGet.mockRejectedValueOnce(new Error('permission denied'));

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.ok).toBe(false);
  });

  it('returns 503 when the admin sdk is not initialized', async () => {
    mockGetAdminDb.mockImplementationOnce(() => {
      throw new Error('Firebase Admin SDK not initialized. Check environment variables.');
    });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.ok).toBe(false);
  });

  it('returns 503 when the firestore read exceeds the timeout', async () => {
    jest.useFakeTimers();
    mockGet.mockReturnValueOnce(new Promise(() => {})); // never resolves

    const resPromise = GET();
    await jest.advanceTimersByTimeAsync(2_500);
    const res = await resPromise;
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.ok).toBe(false);
    jest.useRealTimers();
  });

  it('labels the origin as railway when RAILWAY_PUBLIC_DOMAIN is set', async () => {
    process.env.RAILWAY_PUBLIC_DOMAIN = 'owlette.up.railway.app';

    const res = await GET();
    const body = await res.json();

    expect(body.origin).toBe('railway');
  });

  it('labels the origin as vercel with region when running on vercel', async () => {
    process.env.VERCEL = '1';
    process.env.VERCEL_REGION = 'iad1';

    const res = await GET();
    const body = await res.json();

    expect(body.origin).toBe('vercel:iad1');
  });

  it('labels the origin as unknown when neither provider env is present', async () => {
    const res = await GET();
    const body = await res.json();

    expect(body.origin).toBe('unknown');
  });
});
