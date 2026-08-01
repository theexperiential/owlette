/** @jest-environment node */

/**
 * Stripe SDK singleton (billing-system wave 1.2).
 *
 * Pins the three decisions the rest of billing depends on:
 *   - the client is LAZY — importing this module with no key configured must
 *     not throw, or every route that touches billing dies at import time for
 *     the whole pre-go-live window,
 *   - `stripeMode()` reads the KEY, not which variable supplied it, so a test
 *     key in the prod variable can never be reported as live, and
 *   - the api version is pinned rather than following the Stripe account's
 *     dashboard default, which can drift without a deploy.
 *
 * `stripe` is mocked so no client is ever really constructed and the secret
 * handed to the constructor can be asserted on without a network stack.
 *
 * Every test loads its OWN copy of the module. The singleton caches its
 * client in module scope — exactly what it is supposed to do — so a shared
 * instance would let one test's cached client answer the next test's call.
 */

const mockStripeConstructor = jest.fn();

jest.mock('stripe', () => ({
  __esModule: true,
  default: class MockStripe {
    constructor(...args: unknown[]) {
      mockStripeConstructor(...args);
    }
  },
}));

type StripeServer = typeof import('@/lib/stripe.server');

/** A fresh module instance, with the singleton cache empty. */
async function loadStripeServer(): Promise<StripeServer> {
  jest.resetModules();
  return import('@/lib/stripe.server');
}

const LIVE_KEY = 'sk_live_fake_for_tests';
const TEST_KEY = 'sk_test_fake_for_tests';

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY_TEST;
});

afterAll(() => {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY_TEST;
});

describe('stripeMode', () => {
  it('reports unconfigured when neither variable is set', async () => {
    const { stripeMode, isStripeConfigured } = await loadStripeServer();
    expect(stripeMode()).toBe('unconfigured');
    expect(isStripeConfigured()).toBe(false);
  });

  it('reports unconfigured for a blank or whitespace-only value', async () => {
    // Railway happily stores an empty value; handing that to the SDK would
    // turn every call into a 401 instead of a clean skip.
    process.env.STRIPE_SECRET_KEY = '   ';
    const { stripeMode } = await loadStripeServer();
    expect(stripeMode()).toBe('unconfigured');
  });

  it('reads live from the key prefix', async () => {
    process.env.STRIPE_SECRET_KEY = LIVE_KEY;
    const { stripeMode } = await loadStripeServer();
    expect(stripeMode()).toBe('live');
  });

  it('reports test for a test key sitting in the prod variable', async () => {
    // Reporting this as live would be the more dangerous lie.
    process.env.STRIPE_SECRET_KEY = TEST_KEY;
    const { stripeMode } = await loadStripeServer();
    expect(stripeMode()).toBe('test');
  });

  it('reports test for an unrecognisable value', async () => {
    process.env.STRIPE_SECRET_KEY = 'garbage';
    const { stripeMode } = await loadStripeServer();
    expect(stripeMode()).toBe('test');
  });

  it('recognises a restricted live key', async () => {
    process.env.STRIPE_SECRET_KEY = 'rk_live_fake_for_tests';
    const { stripeMode } = await loadStripeServer();
    expect(stripeMode()).toBe('live');
  });

  it('falls back to the test variable when the prod one is unset', async () => {
    process.env.STRIPE_SECRET_KEY_TEST = TEST_KEY;
    const { stripeMode, isStripeConfigured } = await loadStripeServer();
    expect(stripeMode()).toBe('test');
    expect(isStripeConfigured()).toBe(true);
  });
});

describe('getStripe', () => {
  it('imports cleanly and throws only on use when unconfigured', async () => {
    // The lazy contract: no key must not be an import-time failure.
    const { getStripe, StripeNotConfiguredError } = await loadStripeServer();
    expect(mockStripeConstructor).not.toHaveBeenCalled();
    expect(() => getStripe()).toThrow(StripeNotConfiguredError);
    expect(() => getStripe()).toThrow(/STRIPE_SECRET_KEY/);
  });

  it('constructs the client with the pinned api version and a bounded timeout', async () => {
    process.env.STRIPE_SECRET_KEY = LIVE_KEY;
    const { getStripe, STRIPE_API_VERSION, STRIPE_TIMEOUT_MS } = await loadStripeServer();

    getStripe();

    expect(mockStripeConstructor).toHaveBeenCalledTimes(1);
    const [key, config] = mockStripeConstructor.mock.calls[0];
    expect(key).toBe(LIVE_KEY);
    expect(config).toMatchObject({
      apiVersion: STRIPE_API_VERSION,
      timeout: STRIPE_TIMEOUT_MS,
      maxNetworkRetries: 1,
    });
    // The SDK default is 80s — unusable inside a request handler.
    expect(STRIPE_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it('prefers STRIPE_SECRET_KEY over STRIPE_SECRET_KEY_TEST', async () => {
    process.env.STRIPE_SECRET_KEY = LIVE_KEY;
    process.env.STRIPE_SECRET_KEY_TEST = TEST_KEY;
    const { getStripe } = await loadStripeServer();

    getStripe();

    expect(mockStripeConstructor.mock.calls[0][0]).toBe(LIVE_KEY);
  });

  it('caches the client across calls', async () => {
    process.env.STRIPE_SECRET_KEY = LIVE_KEY;
    const { getStripe } = await loadStripeServer();

    const first = getStripe();
    const second = getStripe();

    expect(first).toBe(second);
    expect(mockStripeConstructor).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the client when the key changes', async () => {
    // A key rotated in a running process must not keep authenticating with
    // the old credential.
    process.env.STRIPE_SECRET_KEY = LIVE_KEY;
    const { getStripe } = await loadStripeServer();
    getStripe();
    process.env.STRIPE_SECRET_KEY = TEST_KEY;
    getStripe();

    expect(mockStripeConstructor).toHaveBeenCalledTimes(2);
    expect(mockStripeConstructor.mock.calls[1][0]).toBe(TEST_KEY);
  });
});

describe('getStripeOrNull', () => {
  it('returns null instead of throwing when unconfigured', async () => {
    const { getStripeOrNull } = await loadStripeServer();
    expect(getStripeOrNull()).toBeNull();
    expect(mockStripeConstructor).not.toHaveBeenCalled();
  });

  it('returns the client when configured', async () => {
    process.env.STRIPE_SECRET_KEY = TEST_KEY;
    const { getStripeOrNull } = await loadStripeServer();
    expect(getStripeOrNull()).not.toBeNull();
  });
});
