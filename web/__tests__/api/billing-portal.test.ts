/** @jest-environment node */

/**
 * Route-level tests for POST /api/billing/portal (billing-system wave 1.4).
 *
 * The three things a regression would break silently:
 *   - an unauthenticated caller minting a portal session (it can cancel a
 *     subscription and read every invoice),
 *   - a 500 instead of an explained problem+json when the account has no
 *     Stripe customer yet — the normal state for every trialing account, and
 *     the copy the "manage billing" button surfaces as its toast,
 *   - a portal session created against a customer id other than the caller's
 *     own `customers/{uid}`.
 */

import { createMockRequest, parseResponse } from './helpers/utils';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockRequireSessionOrIdToken = jest.fn();
const mockAssertActiveUser = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    requireSessionOrIdToken: (...a: unknown[]) => mockRequireSessionOrIdToken(...a),
    assertActiveUser: (...a: unknown[]) => mockAssertActiveUser(...a),
  };
});

const mockCustomerGet = jest.fn();
jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: jest.fn(),
  getAdminDb: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({ get: () => mockCustomerGet(name, id) }),
    }),
  }),
}));

const mockPortalCreate = jest.fn();
const mockGetStripeOrNull = jest.fn();
jest.mock('@/lib/stripe.server', () => ({
  getStripeOrNull: () => mockGetStripeOrNull(),
}));

// Keep the real limiter wiring but force an always-allow verdict — the
// in-memory limiter is stateful across tests otherwise.
jest.mock('@/lib/rateLimit', () => {
  const actual = jest.requireActual('@/lib/rateLimit');
  return {
    ...actual,
    checkRateLimit: jest.fn(async () => ({
      success: true,
      limit: 100,
      remaining: 99,
      reset: 1_000_000,
    })),
  };
});

import { ApiAuthError } from '@/lib/apiAuth.server';
import { POST } from '@/app/api/billing/portal/route';

function portalReq() {
  return createMockRequest('/api/billing/portal', { method: 'POST' });
}

/** A customers doc snapshot as the route reads it. */
function customerSnap(data: Record<string, unknown> | null) {
  return {
    exists: data !== null,
    data: () => data ?? undefined,
  };
}

describe('POST /api/billing/portal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireSessionOrIdToken.mockResolvedValue('uid-owner');
    mockAssertActiveUser.mockResolvedValue({ role: 'member', sites: [] });
    mockCustomerGet.mockResolvedValue(
      customerSnap({ stripeCustomerId: 'cus_owner', billingState: 'active' }),
    );
    mockPortalCreate.mockResolvedValue({ url: 'https://billing.stripe.com/session/abc' });
    mockGetStripeOrNull.mockReturnValue({
      billingPortal: { sessions: { create: mockPortalCreate } },
    });
    process.env.NEXT_PUBLIC_BASE_URL = 'https://owlette.test';
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_BASE_URL;
  });

  it('returns a portal url for the caller own customer record', async () => {
    const res = await POST(portalReq());
    const { status, body } = await parseResponse(res);

    expect(status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      url: 'https://billing.stripe.com/session/abc',
    });
    // Owner-only falls out of the addressing: the customer id comes from
    // `customers/{verified uid}`, never from the request.
    expect(mockCustomerGet).toHaveBeenCalledWith('customers', 'uid-owner');
    expect(mockPortalCreate).toHaveBeenCalledWith({
      customer: 'cus_owner',
      return_url: 'https://owlette.test/dashboard',
    });
  });

  it('asks the auth layer to reject agent tokens', async () => {
    // A portal session can cancel a subscription and read every invoice — a
    // scraped agent/api credential must not reach it. `rejectAgentTokens` is
    // the flag that enforces it, so its absence has to fail a test.
    await POST(portalReq());
    expect(mockRequireSessionOrIdToken).toHaveBeenCalledWith(
      expect.anything(),
      { rejectAgentTokens: true },
    );
  });

  it('401s an unauthenticated caller before touching stripe', async () => {
    mockRequireSessionOrIdToken.mockRejectedValue(
      new ApiAuthError(401, 'Unauthorized: No valid session'),
    );

    const res = await POST(portalReq());
    const { status, body } = await parseResponse(res);

    expect(status).toBe(401);
    expect(body).toMatchObject({ code: 'unauthorized' });
    expect(mockGetStripeOrNull).not.toHaveBeenCalled();
    expect(mockPortalCreate).not.toHaveBeenCalled();
  });

  it('403s a soft-deleted account holding a stale session', async () => {
    mockAssertActiveUser.mockRejectedValue(
      new ApiAuthError(403, 'Forbidden: User is deleted or inactive', {
        code: 'user_inactive',
      }),
    );

    const res = await POST(portalReq());
    const { status } = await parseResponse(res);

    expect(status).toBe(403);
    expect(mockPortalCreate).not.toHaveBeenCalled();
  });

  it('409s with no_billing_account when the account has no stripe customer', async () => {
    mockCustomerGet.mockResolvedValue(customerSnap({ stripeCustomerId: null }));

    const res = await POST(portalReq());
    const { status, body } = await parseResponse(res);

    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'no_billing_account' });
    expect(body.detail).toEqual(expect.any(String));
    expect(mockPortalCreate).not.toHaveBeenCalled();
  });

  it('409s when the customers doc does not exist at all', async () => {
    mockCustomerGet.mockResolvedValue(customerSnap(null));

    const res = await POST(portalReq());
    const { status, body } = await parseResponse(res);

    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'no_billing_account' });
  });

  it('503s with billing_unavailable when stripe is unconfigured', async () => {
    mockGetStripeOrNull.mockReturnValue(null);

    const res = await POST(portalReq());
    const { status, body } = await parseResponse(res);

    expect(status).toBe(503);
    expect(body).toMatchObject({ code: 'billing_unavailable' });
    // Resolved before the customers read — no Firestore round trip wasted on
    // a deployment that can't serve the request anyway.
    expect(mockCustomerGet).not.toHaveBeenCalled();
  });

  it('500s without leaking the stripe error message when the api call fails', async () => {
    mockPortalCreate.mockRejectedValue(new Error('No such customer: cus_owner'));

    const res = await POST(portalReq());
    const { status, body } = await parseResponse(res);

    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('cus_owner');
  });

  it('falls back to the public origin when NEXT_PUBLIC_BASE_URL is unset', async () => {
    // The return url must never come from the request Host header — a
    // spoofing proxy could otherwise plant an off-site link in a
    // Stripe-hosted page.
    delete process.env.NEXT_PUBLIC_BASE_URL;

    await POST(portalReq());

    expect(mockPortalCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        return_url: expect.stringMatching(/^https:\/\/(dev\.)?owlette\.app\/dashboard$/),
      }),
    );
  });
});
