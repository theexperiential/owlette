/** @jest-environment node */

import { NextRequest } from 'next/server';

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
    requireAdmin: jest.fn().mockResolvedValue('test-admin'),
    ApiAuthError: _ApiAuthError,
  };
});

const { requireAdmin, ApiAuthError } = jest.requireMock('@/lib/apiAuth.server');

const mockDocGet = jest.fn();
const mockDocUpdate = jest.fn().mockResolvedValue(undefined);

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: () => ({
      doc: () => ({
        get: mockDocGet,
        ref: { update: mockDocUpdate },
      }),
    }),
  }),
}));

const mockTestWebhook = jest.fn();
jest.mock('@/lib/webhookSender.server', () => ({
  testWebhook: (...args: any[]) => mockTestWebhook(...args),
}));

import { POST } from '@/app/api/webhooks/test/route';

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/webhooks/test', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/webhooks/test', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 400 when webhookId is missing', async () => {
    const res = await POST(makeRequest({ siteId: 's1' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/webhookId/i);
  });

  it('returns 400 when siteId is missing', async () => {
    const res = await POST(makeRequest({ webhookId: 'wh-1' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/siteId/i);
  });

  it('returns 404 when webhook does not exist', async () => {
    mockDocGet.mockResolvedValue({ exists: false });

    const res = await POST(makeRequest({ webhookId: 'wh-1', siteId: 's1' }));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toMatch(/not found/i);
  });

  it('sends test and returns success for 2xx response', async () => {
    mockDocGet.mockResolvedValue({
      exists: true,
      data: () => ({ url: 'https://hooks.example.com', secret: 'abc' }),
      ref: { update: mockDocUpdate },
    });
    mockTestWebhook.mockResolvedValue({ status: 200 });

    const res = await POST(makeRequest({ webhookId: 'wh-1', siteId: 's1' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.status).toBe(200);
    expect(mockTestWebhook).toHaveBeenCalledWith('https://hooks.example.com', 'abc');
  });

  it('returns success:false for non-2xx response', async () => {
    mockDocGet.mockResolvedValue({
      exists: true,
      data: () => ({ url: 'https://hooks.example.com', secret: 'abc' }),
      ref: { update: mockDocUpdate },
    });
    mockTestWebhook.mockResolvedValue({ status: 500 });

    const res = await POST(makeRequest({ webhookId: 'wh-1', siteId: 's1' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(false);
    expect(json.status).toBe(500);
  });

  it('returns error message on network failure', async () => {
    mockDocGet.mockResolvedValue({
      exists: true,
      data: () => ({ url: 'https://hooks.example.com', secret: 'abc' }),
      ref: { update: mockDocUpdate },
    });
    mockTestWebhook.mockResolvedValue({ status: 0, error: 'ECONNREFUSED' });

    const res = await POST(makeRequest({ webhookId: 'wh-1', siteId: 's1' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(false);
    expect(json.error).toBe('ECONNREFUSED');
  });

  it('returns 401 when not admin', async () => {
    (requireAdmin as jest.Mock).mockRejectedValueOnce(
      new ApiAuthError(401, 'Unauthorized')
    );

    const res = await POST(makeRequest({ webhookId: 'wh-1', siteId: 's1' }));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Unauthorized');
  });
});
