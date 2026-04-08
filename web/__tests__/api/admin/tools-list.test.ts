/** @jest-environment node */

import { NextRequest } from 'next/server';

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (handler: any) => handler,
}));

jest.mock('@/lib/apiAuth.server', () => {
  class _ApiAuthError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    requireAdminOrIdToken: jest.fn().mockResolvedValue('test-admin'),
    ApiAuthError: _ApiAuthError,
  };
});

const { requireAdminOrIdToken, ApiAuthError } = jest.requireMock('@/lib/apiAuth.server');

import { GET } from '@/app/api/admin/tools/route';

function makeRequest(query = '') {
  return new NextRequest(`http://localhost/api/admin/tools${query}`);
}

describe('GET /api/admin/tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (requireAdminOrIdToken as jest.Mock).mockResolvedValue('test-admin');
  });

  it('returns all tools when no tier filter', async () => {
    const res = await GET(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.count).toBeGreaterThan(0);
    expect(json.tools).toHaveLength(json.count);
    expect(json.tools[0]).toHaveProperty('name');
    expect(json.tools[0]).toHaveProperty('tier');
    expect(json.tools[0]).toHaveProperty('description');
    expect(json.tools[0]).toHaveProperty('parameters');
    expect(json.tools.every((t: any) => [1, 2, 3].includes(t.tier))).toBe(true);
  });

  it('filters by tier=1', async () => {
    const res = await GET(makeRequest('?tier=1'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.count).toBeGreaterThan(0);
    expect(json.tools).toHaveLength(json.count);
    expect(json.tools.every((t: any) => t.tier === 1)).toBe(true);
  });

  it('filters by tier=2 (includes tier 1)', async () => {
    const res = await GET(makeRequest('?tier=2'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.count).toBeGreaterThan(0);
    expect(json.tools).toHaveLength(json.count);
    expect(json.tools.every((t: any) => t.tier <= 2)).toBe(true);
    expect(json.count).toBeGreaterThan(json.tools.filter((t: any) => t.tier === 1).length);
  });

  it('clamps invalid tier values', async () => {
    const allRes = await GET(makeRequest());
    const allJson = await allRes.json();

    const res = await GET(makeRequest('?tier=99'));
    const json = await res.json();
    expect(json.count).toBe(allJson.count); // clamped to 3 = all tools

    const res2 = await GET(makeRequest('?tier=0'));
    const json2 = await res2.json();
    expect(json2.tools.every((t: any) => t.tier === 1)).toBe(true); // clamped to 1
  });

  it('returns 401 when unauthorized', async () => {
    (requireAdminOrIdToken as jest.Mock).mockRejectedValueOnce(
      new ApiAuthError(401, 'Unauthorized')
    );
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });
});
