/** @jest-environment node */

import { NextRequest } from 'next/server';

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (handler: any) => handler,
}));
jest.mock('@/lib/logger', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  __esModule: true,
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
    assertUserHasSiteAccess: jest.fn().mockResolvedValue({ siteId: 's1', siteData: {} }),
    ApiAuthError: _ApiAuthError,
  };
});

const { requireAdminOrIdToken, assertUserHasSiteAccess, ApiAuthError } =
  jest.requireMock('@/lib/apiAuth.server');

const mockCollectionGet = jest.fn();
const mockAdd = jest.fn();
const mockDelete = jest.fn().mockResolvedValue(undefined);

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: () => ({
      get: mockCollectionGet,
      add: mockAdd,
      doc: () => ({
        delete: mockDelete,
      }),
    }),
  }),
}));

import { GET, POST, DELETE } from '@/app/api/admin/webhooks/route';

function makeGetRequest(siteId?: string) {
  const url = siteId
    ? `http://localhost/api/admin/webhooks?siteId=${siteId}`
    : 'http://localhost/api/admin/webhooks';
  return new NextRequest(url, { method: 'GET' });
}

function makePostRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/admin/webhooks', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeDeleteRequest(siteId?: string, webhookId?: string) {
  const params = new URLSearchParams();
  if (siteId) params.set('siteId', siteId);
  if (webhookId) params.set('webhookId', webhookId);
  return new NextRequest(
    `http://localhost/api/admin/webhooks?${params.toString()}`,
    { method: 'DELETE' }
  );
}

describe('GET /api/admin/webhooks', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 400 when siteId is missing', async () => {
    const res = await GET(makeGetRequest());
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/siteId/i);
  });

  it('returns webhooks for a site', async () => {
    mockCollectionGet.mockResolvedValue({
      docs: [
        {
          id: 'wh-1',
          data: () => ({
            url: 'https://hooks.slack.com/abc',
            name: 'Slack',
            events: ['process.crashed'],
            enabled: true,
            secret: 'secret123',
            failCount: 0,
            lastTriggered: { toDate: () => new Date('2026-01-01') },
            createdAt: { toDate: () => new Date('2025-12-01') },
          }),
        },
      ],
    });

    const res = await GET(makeGetRequest('s1'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.webhooks).toHaveLength(1);
    expect(json.webhooks[0].id).toBe('wh-1');
    expect(json.webhooks[0].name).toBe('Slack');
    expect(json.webhooks[0].lastTriggered).toBe('2026-01-01T00:00:00.000Z');
    expect(json.webhooks[0].createdAt).toBe('2025-12-01T00:00:00.000Z');
  });

  it('returns 401 when unauthorized', async () => {
    (requireAdminOrIdToken as jest.Mock).mockRejectedValueOnce(
      new ApiAuthError(401, 'Unauthorized')
    );

    const res = await GET(makeGetRequest('s1'));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Unauthorized');
  });
});

describe('POST /api/admin/webhooks', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates a webhook and returns id + secret', async () => {
    mockAdd.mockResolvedValue({ id: 'new-wh-1' });

    const res = await POST(
      makePostRequest({
        siteId: 's1',
        name: 'Slack #alerts',
        url: 'https://hooks.slack.com/services/abc',
        events: ['machine.offline', 'process.crashed'],
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.webhookId).toBe('new-wh-1');
    expect(json.secret).toMatch(/^[a-f0-9]{64}$/); // 32 random bytes = 64 hex chars
    expect(mockAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://hooks.slack.com/services/abc',
        name: 'Slack #alerts',
        events: ['machine.offline', 'process.crashed'],
        enabled: true,
        failCount: 0,
        createdBy: 'test-admin',
      })
    );
  });

  it('returns 400 when name is missing', async () => {
    const res = await POST(
      makePostRequest({ siteId: 's1', url: 'https://example.com', events: ['test'] })
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when url is missing', async () => {
    const res = await POST(
      makePostRequest({ siteId: 's1', name: 'test', events: ['test'] })
    );
    expect(res.status).toBe(400);
  });

  it('rejects HTTP urls (requires HTTPS)', async () => {
    const res = await POST(
      makePostRequest({
        siteId: 's1',
        name: 'test',
        url: 'http://insecure.example.com',
        events: ['test'],
      })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/https/i);
  });

  it('rejects empty events array', async () => {
    const res = await POST(
      makePostRequest({
        siteId: 's1',
        name: 'test',
        url: 'https://example.com',
        events: [],
      })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/events/i);
  });

  it('rejects non-array events', async () => {
    const res = await POST(
      makePostRequest({
        siteId: 's1',
        name: 'test',
        url: 'https://example.com',
        events: 'machine.offline',
      })
    );
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/admin/webhooks', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes a webhook', async () => {
    const res = await DELETE(makeDeleteRequest('s1', 'wh-1'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockDelete).toHaveBeenCalled();
  });

  it('returns 400 when siteId is missing', async () => {
    const res = await DELETE(makeDeleteRequest(undefined, 'wh-1'));
    expect(res.status).toBe(400);
  });

  it('returns 400 when webhookId is missing', async () => {
    const res = await DELETE(makeDeleteRequest('s1'));
    expect(res.status).toBe(400);
  });

  it('returns 403 when user lacks site access', async () => {
    (assertUserHasSiteAccess as jest.Mock).mockRejectedValueOnce(
      new ApiAuthError(403, 'Forbidden')
    );

    const res = await DELETE(makeDeleteRequest('s1', 'wh-1'));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error).toBe('Forbidden');
  });
});
