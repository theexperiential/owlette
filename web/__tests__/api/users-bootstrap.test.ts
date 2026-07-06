/** @jest-environment node */

/**
 * Route-level tests for POST /api/users/bootstrap — the signup-abuse controls
 * plus the verified-email pin (issue #22).
 *
 * The pure helpers (isDisposableEmailDomain, sanitizeDisplayName) are unit-
 * tested elsewhere; these tests pin the ROUTE wiring that those unit tests
 * can't see:
 *   - the persisted email is the VERIFIED Firebase Auth email (getUser(uid)),
 *     never the client-supplied body.email — so a bot can't authenticate with a
 *     disposable address and store a clean one, or vice-versa,
 *   - a disposable VERIFIED email is rejected with 400 BEFORE any DB write
 *     (bootstrapUser is never called), and
 *   - the per-IP signup rate limit short-circuits with 429 before the handler
 *     runs.
 * A regression that re-trusted body.email, dropped the withRateLimit wrap, or
 * moved the disposable check after the bootstrap write, would pass the old
 * tests but fail here.
 */

import { createMockRequest, parseResponse } from './helpers/utils';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

// Firebase Auth record lookup — the route reads the AUTHORITATIVE email from
// getAdminAuth().getUser(uid). getAdminDb is also exported here and pulled in
// transitively by apiAuth.server, so keep it present (unused in these tests).
const mockGetUser = jest.fn();
jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({ getUser: (...a: unknown[]) => mockGetUser(...a) }),
  getAdminDb: jest.fn(),
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
    mockGetUser.mockResolvedValue({ uid: 'uid-test', email: 'real@gmail.com' });
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

  it('rejects when the VERIFIED account email is a disposable domain — even if body.email is clean', async () => {
    // Bot authenticates with a disposable address but POSTs a clean one.
    mockGetUser.mockResolvedValue({ uid: 'uid-test', email: 'bot@mailinator.com' });
    const res = await POST(bootstrapReq({ email: 'clean@gmail.com' }));
    const { status, body } = await parseResponse(res);
    expect(status).toBe(400);
    expect(JSON.stringify(body)).toMatch(/disposable/i);
    expect(mockBootstrapUser).not.toHaveBeenCalled();
  });

  it('persists the VERIFIED token email, never the client-supplied body.email', async () => {
    const res = await POST(
      bootstrapReq({ email: 'attacker-controlled@evil.com', displayName: 'Real Person' }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(200);
    expect(mockBootstrapUser).toHaveBeenCalledTimes(1);
    const input = mockBootstrapUser.mock.calls[0][1] as { email: string };
    expect(input.email).toBe('real@gmail.com'); // from getUser(uid), not the body
  });

  it('rejects with 400 when the account has no usable verified email', async () => {
    mockGetUser.mockResolvedValue({ uid: 'uid-test', email: undefined });
    const res = await POST(bootstrapReq({ email: 'real@gmail.com' }));
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
    expect(mockBootstrapUser).not.toHaveBeenCalled();
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
});
