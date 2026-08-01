/** @jest-environment node */

/**
 * Route-level tests for POST /api/billing/checkout (billing-system wave 2.1).
 *
 * What a regression here would break silently:
 *   - the wrong prices on a session — a pro checkout missing the storage
 *     overage item bills nothing for roost storage, forever, invisibly;
 *   - a `quantity` creeping back onto a metered line item (Stripe rejects it,
 *     but only at conversion time, i.e. in front of a paying customer);
 *   - a second subscription bought by an account that already has one;
 *   - the route writing entitlement instead of leaving it to the webhook.
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

const mockDocGet = jest.fn();
const mockDocUpdate = jest.fn();
jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: jest.fn(),
  getAdminDb: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: () => mockDocGet(name, id),
        update: (data: unknown) => mockDocUpdate(name, id, data),
      }),
    }),
  }),
}));

const mockSessionCreate = jest.fn();
const mockGetStripeOrNull = jest.fn();
jest.mock('@/lib/stripe.server', () => ({
  getStripeOrNull: () => mockGetStripeOrNull(),
}));

const mockLinkStripeCustomer = jest.fn();
jest.mock('@/lib/billing/stripeCustomer.server', () => ({
  linkStripeCustomer: (...a: unknown[]) => mockLinkStripeCustomer(...a),
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
import { POST } from '@/app/api/billing/checkout/route';

const CORE_PRICE = 'price_core_machine';
const PRO_PRICE = 'price_pro_machine';
const OVERAGE_PRICE = 'price_pro_storage_overage';

function checkoutReq(body?: Record<string, unknown>) {
  return createMockRequest('/api/billing/checkout', { method: 'POST', body });
}

/** A `customers/{uid}` snapshot as the route reads it. */
function customerSnap(data: Record<string, unknown> | null) {
  return { exists: data !== null, data: () => data ?? undefined };
}

/** The single session-create call the route made. */
function createdSession() {
  expect(mockSessionCreate).toHaveBeenCalledTimes(1);
  return mockSessionCreate.mock.calls[0][0];
}

describe('POST /api/billing/checkout', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireSessionOrIdToken.mockResolvedValue('uid-owner');
    mockAssertActiveUser.mockResolvedValue({
      role: 'member',
      sites: [],
      email: 'owner@example.com',
    });
    // Trialing account with a Stripe customer already linked at signup.
    mockDocGet.mockResolvedValue(
      customerSnap({
        stripeCustomerId: 'cus_owner',
        subscriptionStatus: null,
        trialEndsAt: null,
      }),
    );
    mockSessionCreate.mockResolvedValue({
      id: 'cs_test_123',
      url: 'https://checkout.stripe.com/c/pay/cs_test_123',
    });
    mockGetStripeOrNull.mockReturnValue({
      checkout: { sessions: { create: mockSessionCreate } },
    });
    mockLinkStripeCustomer.mockResolvedValue('cus_linked');

    process.env.NEXT_PUBLIC_BASE_URL = 'https://owlette.test';
    process.env.STRIPE_PRICE_CORE_MACHINE = CORE_PRICE;
    process.env.STRIPE_PRICE_PRO_MACHINE = PRO_PRICE;
    process.env.STRIPE_PRICE_PRO_STORAGE_OVERAGE = OVERAGE_PRICE;
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_BASE_URL;
    delete process.env.STRIPE_PRICE_CORE_MACHINE;
    delete process.env.STRIPE_PRICE_PRO_MACHINE;
    delete process.env.STRIPE_PRICE_PRO_STORAGE_OVERAGE;
  });

  describe('line items', () => {
    it('puts the single core machine price on a core session', async () => {
      const res = await POST(checkoutReq({ tier: 'core' }));
      const { status, body } = await parseResponse(res);

      expect(status).toBe(200);
      expect(body).toMatchObject({
        success: true,
        url: 'https://checkout.stripe.com/c/pay/cs_test_123',
      });
      expect(createdSession().line_items).toEqual([{ price: CORE_PRICE }]);
    });

    it('puts machine + storage-overage prices on a pro session', async () => {
      await POST(checkoutReq({ tier: 'pro' }));

      // Order matters only for readability on the Stripe dashboard, but the
      // overage item's PRESENCE is load-bearing: without it roost storage is
      // never billed and the omission is silent.
      expect(createdSession().line_items).toEqual([
        { price: PRO_PRICE },
        { price: OVERAGE_PRICE },
      ]);
    });

    it('never sends a quantity — every price is metered', async () => {
      await POST(checkoutReq({ tier: 'pro' }));

      for (const item of createdSession().line_items) {
        expect(item).not.toHaveProperty('quantity');
      }
    });
  });

  describe('session shape', () => {
    it('creates a subscription-mode session against the caller own customer', async () => {
      await POST(checkoutReq({ tier: 'pro' }));

      expect(createdSession()).toMatchObject({
        mode: 'subscription',
        customer: 'cus_owner',
        payment_method_collection: 'always',
        success_url: 'https://owlette.test/dashboard?checkout=success',
        cancel_url: 'https://owlette.test/dashboard?checkout=canceled',
      });
      // Owner-only falls out of the addressing: the customer id comes from
      // `customers/{verified uid}`, never from the request.
      expect(mockDocGet).toHaveBeenCalledWith('customers', 'uid-owner');
    });

    it('stamps uid + tier metadata on both the session and the subscription', async () => {
      await POST(checkoutReq({ tier: 'core' }));

      const session = createdSession();
      expect(session.metadata).toEqual({ uid: 'uid-owner', tier: 'core' });
      expect(session.subscription_data.metadata).toEqual({
        uid: 'uid-owner',
        tier: 'core',
      });
    });

    it('sets no stripe-side trial — the trial is app-managed and already spent', async () => {
      await POST(checkoutReq({ tier: 'pro' }));

      const { subscription_data: subscriptionData } = createdSession();
      expect(subscriptionData).not.toHaveProperty('trial_period_days');
      expect(subscriptionData).not.toHaveProperty('trial_end');
    });

    it('falls back to the public origin when NEXT_PUBLIC_BASE_URL is unset', async () => {
      // The return urls must never come from the request Host header — a
      // spoofing proxy could otherwise plant an off-site link in a
      // Stripe-hosted page.
      delete process.env.NEXT_PUBLIC_BASE_URL;

      await POST(checkoutReq({ tier: 'core' }));

      expect(createdSession()).toMatchObject({
        success_url: expect.stringMatching(
          /^https:\/\/(dev\.)?owlette\.app\/dashboard\?checkout=success$/,
        ),
        cancel_url: expect.stringMatching(
          /^https:\/\/(dev\.)?owlette\.app\/dashboard\?checkout=canceled$/,
        ),
      });
    });

    it('writes no tier or billing state — the webhook is the only writer', async () => {
      await POST(checkoutReq({ tier: 'pro' }));

      // The customer was already linked, so the route must not write at all.
      expect(mockDocUpdate).not.toHaveBeenCalled();
      expect(mockLinkStripeCustomer).not.toHaveBeenCalled();
    });
  });

  describe('customer resolution', () => {
    it('mints a stripe customer through the shared linker when none exists', async () => {
      mockDocGet.mockResolvedValue(
        customerSnap({ stripeCustomerId: null, trialEndsAt: null }),
      );

      await POST(checkoutReq({ tier: 'core' }));

      expect(mockLinkStripeCustomer).toHaveBeenCalledWith(
        expect.objectContaining({ uid: 'uid-owner', email: 'owner@example.com' }),
      );
      expect(createdSession().customer).toBe('cus_linked');
    });

    it('500s rather than checking out anonymously when linking fails', async () => {
      mockDocGet.mockResolvedValue(customerSnap({ stripeCustomerId: null }));
      mockLinkStripeCustomer.mockResolvedValue(null);

      const res = await POST(checkoutReq({ tier: 'core' }));
      const { status } = await parseResponse(res);

      expect(status).toBe(500);
      expect(mockSessionCreate).not.toHaveBeenCalled();
    });
  });

  describe('billing state', () => {
    it('409s an account that already has an active subscription', async () => {
      mockDocGet.mockResolvedValue(
        customerSnap({
          stripeCustomerId: 'cus_owner',
          subscriptionStatus: 'active',
          subscriptionId: 'sub_1',
        }),
      );

      const res = await POST(checkoutReq({ tier: 'pro' }));
      const { status, body } = await parseResponse(res);

      expect(status).toBe(409);
      expect(body).toMatchObject({ code: 'already_subscribed' });
      expect(mockSessionCreate).not.toHaveBeenCalled();
    });

    it('409s a past_due account — dunning owns that window, not a new subscription', async () => {
      mockDocGet.mockResolvedValue(
        customerSnap({
          stripeCustomerId: 'cus_owner',
          subscriptionStatus: 'past_due',
          subscriptionId: 'sub_1',
        }),
      );

      const { status } = await parseResponse(await POST(checkoutReq({ tier: 'pro' })));
      expect(status).toBe(409);
    });

    it.each([
      ['expired trial', { subscriptionStatus: null, trialEndsAt: new Date(0) }],
      ['canceled subscription', { subscriptionStatus: 'canceled', subscriptionId: 'sub_1' }],
      ['incomplete checkout', { subscriptionStatus: 'incomplete' }],
      ['live trial', { subscriptionStatus: null, trialEndsAt: null }],
    ])('lets a %s account create a session', async (_label, state) => {
      mockDocGet.mockResolvedValue(
        customerSnap({ stripeCustomerId: 'cus_owner', ...state }),
      );

      const { status } = await parseResponse(await POST(checkoutReq({ tier: 'pro' })));
      expect(status).toBe(200);
      expect(mockSessionCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe('rejections', () => {
    it('401s an unauthenticated caller before touching stripe', async () => {
      mockRequireSessionOrIdToken.mockRejectedValue(
        new ApiAuthError(401, 'Unauthorized: No valid session'),
      );

      const res = await POST(checkoutReq({ tier: 'pro' }));
      const { status, body } = await parseResponse(res);

      expect(status).toBe(401);
      expect(body).toMatchObject({ code: 'unauthorized' });
      expect(mockGetStripeOrNull).not.toHaveBeenCalled();
      expect(mockSessionCreate).not.toHaveBeenCalled();
    });

    it('asks the auth layer to reject agent tokens', async () => {
      // A checkout session attaches a card to this account's Stripe customer.
      // A scraped agent/api credential must not reach it.
      await POST(checkoutReq({ tier: 'pro' }));
      expect(mockRequireSessionOrIdToken).toHaveBeenCalledWith(expect.anything(), {
        rejectAgentTokens: true,
      });
    });

    it('403s a soft-deleted account holding a stale session', async () => {
      mockAssertActiveUser.mockRejectedValue(
        new ApiAuthError(403, 'Forbidden: User is deleted or inactive', {
          code: 'user_inactive',
        }),
      );

      const res = await POST(checkoutReq({ tier: 'pro' }));
      const { status } = await parseResponse(res);

      expect(status).toBe(403);
      expect(mockSessionCreate).not.toHaveBeenCalled();
    });

    it.each([
      ['an unknown tier', { tier: 'enterprise' }],
      ['a missing tier', {}],
      ['a non-string tier', { tier: 3 }],
    ])('400s %s', async (_label, body) => {
      const res = await POST(checkoutReq(body));
      const parsed = await parseResponse(res);

      expect(parsed.status).toBe(400);
      expect(mockSessionCreate).not.toHaveBeenCalled();
    });

    it('400s a request with no body at all', async () => {
      const res = await POST(checkoutReq());
      const { status } = await parseResponse(res);

      expect(status).toBe(400);
      expect(mockSessionCreate).not.toHaveBeenCalled();
    });

    it('503s with billing_unavailable when stripe is unconfigured', async () => {
      mockGetStripeOrNull.mockReturnValue(null);

      const res = await POST(checkoutReq({ tier: 'pro' }));
      const { status, body } = await parseResponse(res);

      expect(status).toBe(503);
      expect(body).toMatchObject({ code: 'billing_unavailable' });
      // Resolved before the customers read — no Firestore round trip wasted on
      // a deployment that can't serve the request anyway.
      expect(mockDocGet).not.toHaveBeenCalled();
    });

    it('503s when the chosen tier has no price ids configured', async () => {
      delete process.env.STRIPE_PRICE_CORE_MACHINE;

      const res = await POST(checkoutReq({ tier: 'core' }));
      const { status, body } = await parseResponse(res);

      expect(status).toBe(503);
      expect(body).toMatchObject({ code: 'billing_unavailable' });
      expect(mockSessionCreate).not.toHaveBeenCalled();
    });

    it('503s on partial pro provisioning rather than billing storage at zero', async () => {
      delete process.env.STRIPE_PRICE_PRO_STORAGE_OVERAGE;

      const { status } = await parseResponse(await POST(checkoutReq({ tier: 'pro' })));

      expect(status).toBe(503);
      expect(mockSessionCreate).not.toHaveBeenCalled();
    });

    it('treats a blank price env as unconfigured', async () => {
      // Railway happily stores an empty string; handing Stripe a blank price
      // id would turn a deployment gap into a 400 from Stripe at conversion.
      process.env.STRIPE_PRICE_CORE_MACHINE = '   ';

      const { status } = await parseResponse(await POST(checkoutReq({ tier: 'core' })));

      expect(status).toBe(503);
      expect(mockSessionCreate).not.toHaveBeenCalled();
    });

    it('500s without leaking the stripe error message when the api call fails', async () => {
      mockSessionCreate.mockRejectedValue(new Error('No such price: price_core_machine'));

      const res = await POST(checkoutReq({ tier: 'core' }));
      const { status, body } = await parseResponse(res);

      expect(status).toBe(500);
      expect(JSON.stringify(body)).not.toContain('price_core_machine');
    });

    it('500s rather than redirecting to a url-less session', async () => {
      mockSessionCreate.mockResolvedValue({ id: 'cs_test_123', url: null });

      const res = await POST(checkoutReq({ tier: 'core' }));
      const { status, body } = await parseResponse(res);

      expect(status).toBe(500);
      expect(body).not.toHaveProperty('url');
    });
  });
});
