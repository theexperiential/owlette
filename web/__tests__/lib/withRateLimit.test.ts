/** @jest-environment node */

import { NextRequest, NextResponse } from 'next/server';
import { ProblemType } from '@/lib/apiErrors';

const mockCheckRateLimit = jest.fn();
const mockGetRateLimitHeaders = jest.fn();
const mockResolveApiKeyRateLimitIdentity = jest.fn();

jest.mock('@/lib/apiAuth.server', () => ({
  resolveApiKeyRateLimitIdentity: (...args: unknown[]) =>
    mockResolveApiKeyRateLimitIdentity(...args),
}));

jest.mock('@/lib/rateLimit', () => ({
  authRateLimit: { kind: 'auth' },
  tokenExchangeRateLimit: { kind: 'tokenExchange' },
  tokenRefreshRateLimit: { kind: 'tokenRefresh' },
  userRateLimit: { kind: 'user' },
  agentAlertRateLimit: { kind: 'agentAlert' },
  uploadRateLimit: { kind: 'upload' },
  apiRateLimit: { kind: 'api' },
  getClientIp: jest.fn(() => '203.0.113.10'),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  getRateLimitHeaders: (...args: unknown[]) => mockGetRateLimitHeaders(...args),
}));

import { withRateLimit } from '@/lib/withRateLimit';

describe('withRateLimit', () => {
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockResolveApiKeyRateLimitIdentity.mockResolvedValue(null);
    mockGetRateLimitHeaders.mockReturnValue({
      'Retry-After': '7',
      'RateLimit-Limit': '10',
      'RateLimit-Remaining': '0',
      'RateLimit-Reset': '7',
      'Roost-Rate-Limited-Reason': 'endpoint-rate',
    });
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  it('returns shared problem+json on 429 while preserving rate-limit metadata', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 7_000,
      retryAfter: 7,
    });
    const handler = jest.fn(async () => NextResponse.json({ ok: true }));
    const wrapped = withRateLimit(handler, { strategy: 'api', identifier: 'ip' });

    const res = await wrapped(new NextRequest('http://localhost/api/test'));
    const body = await res.json();

    expect(handler).not.toHaveBeenCalled();
    expect(res.status).toBe(429);
    expect(res.headers.get('Content-Type')).toBe('application/problem+json; charset=utf-8');
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
    expect(res.headers.get('Retry-After')).toBe('7');
    expect(res.headers.get('Roost-Rate-Limited-Reason')).toBe('endpoint-rate');
    expect(body).toMatchObject({
      type: ProblemType.RateLimited,
      title: 'rate limited',
      status: 429,
      code: 'rate_limited',
      docsUrl: 'https://owlette.app/docs/api/errors#rate_limited',
      retryAfter: 7,
      error: 'Rate limit exceeded',
    });
    expect(body.requestId).toBe(res.headers.get('X-Request-Id'));
  });

  it('uses API key id as the api-strategy identifier when available', async () => {
    mockResolveApiKeyRateLimitIdentity.mockResolvedValueOnce('apiKey:key-a');
    mockCheckRateLimit.mockResolvedValueOnce({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 7_000,
      retryAfter: 7,
    });
    const handler = jest.fn(async () => NextResponse.json({ ok: true }));
    const wrapped = withRateLimit(handler, { strategy: 'api', identifier: 'ip' });

    await wrapped(new NextRequest('http://localhost/api/test', {
      headers: { authorization: 'Bearer owk_live_test' },
    }));

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      { kind: 'api' },
      'apiKey:key-a',
    );
    expect(mockGetRateLimitHeaders).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'key-rate' }),
    );
  });
});
