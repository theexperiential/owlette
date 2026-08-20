/** @jest-environment node */

/**
 * GET /api/agent/site — the only path from a paired agent to its site's label
 * (rules scope the agent to its machine subtree). Two asserted properties: the
 * site comes from the token's `site_id` claim, never the request; and the
 * response projects the name ONLY — leaking the site's `timezone` would flip
 * schedule evaluation fleet-wide.
 */

import { createMockRequest } from '../helpers/utils';

const mockVerifyIdToken = jest.fn();
const mockSiteGet = jest.fn();
const mockDoc = jest.fn();
const mockCollection = jest.fn();

jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({
    verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args),
  }),
  getAdminDb: () => ({
    collection: (...args: unknown[]) => mockCollection(...args),
  }),
}));
jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (h: unknown) => h,
}));
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

import { GET } from '@/app/api/agent/site/route';

function request(headers: Record<string, string> = {}) {
  return createMockRequest('http://localhost/api/agent/site', { method: 'GET', headers });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDoc.mockReturnValue({ get: (...args: unknown[]) => mockSiteGet(...args) });
  mockCollection.mockReturnValue({ doc: (...args: unknown[]) => mockDoc(...args) });
});

describe('GET /api/agent/site', () => {
  it('returns the site name for a valid agent token, read via the site_id claim', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({
      role: 'agent',
      site_id: 'site-a',
      machine_id: 'TEC-A4D',
    });
    mockSiteGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ name: 'TEC', timezone: 'America/Los_Angeles' }),
    });

    const res = await GET(request({ Authorization: 'Bearer agent-token' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ name: 'TEC' });
    // The site is the token's, not the caller's to choose.
    expect(mockCollection).toHaveBeenCalledWith('sites');
    expect(mockDoc).toHaveBeenCalledWith('site-a');
  });

  it('never returns the timezone — activating site-timezone scheduling is a deferred decision', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ role: 'agent', site_id: 'site-a' });
    mockSiteGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        name: 'TEC',
        timezone: 'America/Los_Angeles',
        owner: 'user-1',
        billingState: 'active',
      }),
    });

    const res = await GET(request({ Authorization: 'Bearer agent-token' }));
    const body = await res.json();

    expect(Object.keys(body)).toEqual(['name']);
  });

  it('ignores a siteId supplied in the query string', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ role: 'agent', site_id: 'site-a' });
    mockSiteGet.mockResolvedValueOnce({ exists: true, data: () => ({ name: 'TEC' }) });

    const req = createMockRequest('http://localhost/api/agent/site?siteId=site-victim', {
      method: 'GET',
      headers: { Authorization: 'Bearer agent-token' },
    });
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(mockDoc).toHaveBeenCalledWith('site-a');
    expect(mockDoc).not.toHaveBeenCalledWith('site-victim');
  });

  it('returns name: null when the site has no name set', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ role: 'agent', site_id: 'site-a' });
    mockSiteGet.mockResolvedValueOnce({ exists: true, data: () => ({ name: '   ' }) });

    const res = await GET(request({ Authorization: 'Bearer agent-token' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: null });
  });

  it('trims surrounding whitespace off the stored name', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ role: 'agent', site_id: 'site-a' });
    mockSiteGet.mockResolvedValueOnce({ exists: true, data: () => ({ name: '  TEC  ' }) });

    const res = await GET(request({ Authorization: 'Bearer agent-token' }));

    expect(await res.json()).toEqual({ name: 'TEC' });
  });

  it('returns 401 when the Authorization header is missing', async () => {
    const res = await GET(request());

    expect(res.status).toBe(401);
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = await res.json();
    expect(body.title).toBe('unauthorized');
  });

  it('returns 401 when the bearer token does not verify', async () => {
    mockVerifyIdToken.mockRejectedValueOnce(new Error('token expired'));

    const res = await GET(request({ Authorization: 'Bearer stale-token' }));

    expect(res.status).toBe(401);
    expect(mockSiteGet).not.toHaveBeenCalled();
  });

  it('returns 403 for a non-agent (dashboard user) token', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ uid: 'user-1' });

    const res = await GET(request({ Authorization: 'Bearer user-token' }));

    expect(res.status).toBe(403);
    expect(mockSiteGet).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.detail).toMatch(/agent token required/i);
  });

  it('returns 403 for an agent token with no site_id claim', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ role: 'agent', machine_id: 'TEC-A4D' });

    const res = await GET(request({ Authorization: 'Bearer claimless-token' }));

    expect(res.status).toBe(403);
    expect(mockSiteGet).not.toHaveBeenCalled();
  });

  it('returns 404 when the claimed site document no longer exists', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ role: 'agent', site_id: 'site-deleted' });
    mockSiteGet.mockResolvedValueOnce({ exists: false, data: () => undefined });

    const res = await GET(request({ Authorization: 'Bearer agent-token' }));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.title).toBe('not found');
  });

  it('returns 500 problem+json when the firestore read throws', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ role: 'agent', site_id: 'site-a' });
    mockSiteGet.mockRejectedValueOnce(new Error('backend unavailable'));

    const res = await GET(request({ Authorization: 'Bearer agent-token' }));

    expect(res.status).toBe(500);
  });
});
