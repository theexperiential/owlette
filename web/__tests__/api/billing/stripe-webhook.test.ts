/** @jest-environment node */

/**
 * POST /api/billing/stripe-webhook route tests (billing-system wave 1.3).
 *
 * Scope is the verification boundary: signature handling, raw-body fidelity,
 * status codes, and the no-secrets-in-logs rule. Event semantics are covered
 * against a fake Firestore in `__tests__/lib/billing/stripeEventHandlers.test.ts`,
 * so the handler is mocked here — that keeps a failure in this file
 * unambiguously about the route.
 */
import { NextRequest } from 'next/server';

const mockConstructEvent = jest.fn();
const mockHandleStripeEvent = jest.fn();
const mockGetStripe = jest.fn(() => ({ webhooks: { constructEvent: mockConstructEvent } }));

jest.mock('@/lib/stripe.server', () => ({
  getStripe: () => mockGetStripe(),
  stripeMode: () => 'test',
}));

jest.mock('@/lib/billing/stripeEventHandlers', () => ({
  handleStripeEvent: (...args: unknown[]) => mockHandleStripeEvent(...args),
}));

import { POST } from '@/app/api/billing/stripe-webhook/route';

const LIVE_SECRET = 'whsec_live_fixture';
const TEST_SECRET = 'whsec_test_fixture';
const SIGNATURE = 't=1785000000,v1=deadbeefdeadbeefdeadbeefdeadbeef';

/**
 * A raw body with non-canonical spacing and key order. Any accidental
 * parse-and-re-serialise inside the route would normalise this, and the
 * assertion that `constructEvent` sees it byte-for-byte would fail — which is
 * exactly the bug that silently breaks signature verification in production.
 */
const RAW_BODY =
  '{"id":"evt_test_1",  "type":"customer.subscription.created","object":"event",\n  "data":{"object":{"id":"sub_1"}}}';

const EVENT = {
  id: 'evt_test_1',
  type: 'customer.subscription.created',
} as const;

function request(opts: { signature?: string | null; body?: string } = {}) {
  const { signature = SIGNATURE, body = RAW_BODY } = opts;
  return new NextRequest('http://localhost/api/billing/stripe-webhook', {
    method: 'POST',
    body,
    headers: signature === null ? {} : { 'stripe-signature': signature },
  });
}

describe('POST /api/billing/stripe-webhook', () => {
  const originalEnv = { ...process.env };
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = LIVE_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET_TEST;

    mockGetStripe.mockReturnValue({ webhooks: { constructEvent: mockConstructEvent } });
    mockConstructEvent.mockReturnValue(EVENT);
    mockHandleStripeEvent.mockResolvedValue({
      eventId: EVENT.id,
      type: EVENT.type,
      outcome: 'processed',
      uid: 'owner-1',
    });

    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  /* --- fail closed ------------------------------------------------------ */

  it('rejects a request with no stripe-signature header', async () => {
    const res = await POST(request({ signature: null }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Missing signature' });
    expect(mockConstructEvent).not.toHaveBeenCalled();
    expect(mockHandleStripeEvent).not.toHaveBeenCalled();
  });

  it('rejects when no signing secret is configured', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET_TEST;

    const res = await POST(request());

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Webhook not configured' });
    expect(mockConstructEvent).not.toHaveBeenCalled();
    expect(mockHandleStripeEvent).not.toHaveBeenCalled();
  });

  it('answers 500 — not a bogus 400 — when the stripe sdk is unconfigured', async () => {
    mockGetStripe.mockImplementation(() => {
      throw new Error('Stripe is not configured — set STRIPE_SECRET_KEY');
    });

    const res = await POST(request());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'Stripe not configured' });
    expect(mockConstructEvent).not.toHaveBeenCalled();
    expect(mockHandleStripeEvent).not.toHaveBeenCalled();
  });

  it('rejects a payload whose signature does not verify', async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature for payload');
    });

    const res = await POST(request({ signature: 't=1,v1=bogus' }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Invalid signature' });
    expect(mockHandleStripeEvent).not.toHaveBeenCalled();
  });

  /* --- verification inputs ---------------------------------------------- */

  it('verifies against the exact raw body, signature, and secret', async () => {
    await POST(request());

    expect(mockConstructEvent).toHaveBeenCalledWith(RAW_BODY, SIGNATURE, LIVE_SECRET);
  });

  it('falls back to the test-mode secret when the live one is unset', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_WEBHOOK_SECRET_TEST = TEST_SECRET;

    await POST(request());

    expect(mockConstructEvent).toHaveBeenCalledWith(RAW_BODY, SIGNATURE, TEST_SECRET);
  });

  it('prefers the live secret when both are set', async () => {
    process.env.STRIPE_WEBHOOK_SECRET_TEST = TEST_SECRET;

    await POST(request());

    expect(mockConstructEvent).toHaveBeenCalledWith(RAW_BODY, SIGNATURE, LIVE_SECRET);
  });

  /* --- success + acknowledgement ---------------------------------------- */

  it('dispatches a verified event and acknowledges it', async () => {
    const res = await POST(request());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      received: true,
      eventId: EVENT.id,
      type: EVENT.type,
      outcome: 'processed',
    });
    expect(mockHandleStripeEvent).toHaveBeenCalledWith(EVENT);
  });

  it.each(['duplicate', 'unknown_customer', 'ignored'] as const)(
    'answers 200 for the %s outcome so stripe stops retrying',
    async (outcome) => {
      mockHandleStripeEvent.mockResolvedValue({
        eventId: EVENT.id,
        type: EVENT.type,
        outcome,
        uid: null,
      });

      const res = await POST(request());

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ received: true, outcome });
    },
  );

  it('answers 500 when handling throws, so stripe retries', async () => {
    mockHandleStripeEvent.mockRejectedValue(new Error('firestore unavailable'));

    const res = await POST(request());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'Webhook handling failed' });
  });

  /* --- logging hygiene --------------------------------------------------- */

  it('never logs the signing secret, the signature, or the payload', async () => {
    process.env.STRIPE_WEBHOOK_SECRET_TEST = TEST_SECRET;

    // every branch that logs: bad signature, handler failure, and a clean run
    mockConstructEvent.mockImplementationOnce(() => {
      throw new Error('No signatures found matching the expected signature for payload');
    });
    await POST(request());

    mockHandleStripeEvent.mockRejectedValueOnce(new Error('boom'));
    await POST(request());

    await POST(request({ signature: null }));

    const logged = [...warnSpy.mock.calls, ...errorSpy.mock.calls].flat().join('\n');
    expect(logged).not.toContain(LIVE_SECRET);
    expect(logged).not.toContain(TEST_SECRET);
    expect(logged).not.toContain(SIGNATURE);
    expect(logged).not.toContain(RAW_BODY);
    expect(logged).not.toContain('sub_1');
  });

  it('identifies a failed event by id and type only', async () => {
    mockHandleStripeEvent.mockRejectedValue(new Error('boom'));

    await POST(request());

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`${EVENT.type} ${EVENT.id}`),
    );
  });
});
