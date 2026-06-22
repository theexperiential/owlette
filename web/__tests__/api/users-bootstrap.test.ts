/** @jest-environment node */

/**
 * Route-level tests for POST /api/users/bootstrap — the two signup-abuse
 * controls added in the signup-abuse-tier2 PR.
 *
 * The pure helpers (isDisposableEmailDomain, sanitizeDisplayName) are unit-
 * tested elsewhere; these tests pin the ROUTE wiring that those unit tests
 * can't see:
 *   - a disposable-domain email is rejected with 400 BEFORE any DB write
 *     (bootstrapUser is never called), and
 *   - the per-IP signup rate limit short-circuits with 429 before the handler
 *     runs.
 * A regression that dropped the withRateLimit wrap, or moved the disposable
 * check after the bootstrap write, would pass every existing test but fail here.
 */

import { createMockRequest, parseResponse } from './helpers/utils';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockRequireSessionOrIdToken = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    requireSessionOrIdToken: (...a: unknown[]) => mockRequireSessionOrIdToken(...a),
  };
});

const mockBootstrapUser = jest.fn();
jest.mock('@/lib/actions/bootstrapUser.server', () => ({
  bootstrapUser: (...a: unknown[]) => mockBootstrapUser(...a),
}));

// Idempotency wrapper: just run the inner handler (no Firestore cache in tests).
jest.mock('@/lib/idempotency', () => ({
  withIdempotency: (
    _req: unknown,
    _ctx: unknown,
    _raw: unknown,
    handler: () => unknown,
  ) => handler(),
}));

// Control the rate-limit verdict directly (real Upstash/in-memory limiter is
// bypassed). Keep getClientIp / getRateLimitHeaders / limiter consts real.
const mockCheckRateLimit = jest.fn();
jest.mock('@/lib/rateLimit', () => {
  const actual = jest.requireActual('@/lib/rateLimit');
  return { ...actual, checkRateLimit: (...a: unknown[]) => mockCheckRateLimit(...a) };
});

import { POST } from '@/app/api/users/bootstrap/route';

function bootstrapReq(body: Record<string, unknown>) {
  return createMockRequest('/api/users/bootstrap', { method: 'POST', body });
}

describe('POST /api/users/bootstrap — abuse controls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireSessionOrIdToken.mockResolvedValue('uid-test');
    mockBootstrapUser.mockResolvedValue({
      kind: 'created',
      uid: 'uid-test',
      email: 'real@gmail.com',
      displayName: '',
      timezone: 'UTC',
      createdAt: 1,
    });
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: 1_000_000,
    });
  });

  it('rejects a disposable-domain email with 400 and never writes the user doc', async () => {
    const res = await POST(bootstrapReq({ email: 'bot@mailinator.com' }));
    const { status, body } = await parseResponse(res);
    expect(status).toBe(400);
    expect(JSON.stringify(body)).toMatch(/disposable/i);
    expect(mockBootstrapUser).not.toHaveBeenCalled();
  });

  it('lets a normal email through to bootstrap', async () => {
    const res = await POST(bootstrapReq({ email: 'real@gmail.com', displayName: 'Real Person' }));
    const { status } = await parseResponse(res);
    expect(status).toBe(200);
    expect(mockBootstrapUser).toHaveBeenCalledTimes(1);
  });

  it('returns 429 and never writes when the signup rate limit is exceeded', async () => {
    mockCheckRateLimit.mockResolvedValue({
      success: false,
      retryAfter: 30,
      limit: 10,
      remaining: 0,
      reset: 1_000_000,
    });
    const res = await POST(bootstrapReq({ email: 'real@gmail.com' }));
    const { status } = await parseResponse(res);
    expect(status).toBe(429);
    expect(mockBootstrapUser).not.toHaveBeenCalled();
  });

  it('rejects a malformed email with 400 before the disposable check (validation order)', async () => {
    const res = await POST(bootstrapReq({ email: 'not-an-email' }));
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
    expect(mockBootstrapUser).not.toHaveBeenCalled();
  });
});
