/**
 * Stripe SDK singleton (billing-system wave 1.2).
 *
 * The one place the official `stripe` client is constructed. Everything that
 * talks to Stripe — customer minting at signup, the billing portal, the
 * webhook handler, checkout — goes through `getStripe()` so the api version,
 * the timeout budget, and the retry policy are decided once.
 *
 * ## Lazy on purpose
 *
 * The client is built on first use, never at module load. Billing ships
 * before the Stripe account is provisioned, so for the whole pre-go-live
 * window there is no secret in the environment — and a module-scope
 * `new Stripe(...)` would then throw at *import* time, taking down every
 * route that merely imports a billing helper. Instead, an unconfigured
 * environment is a first-class state: `stripeMode()` reports
 * `'unconfigured'`, `getStripeOrNull()` returns `null`, and only a caller
 * that insists on a client (`getStripe()`) gets a {@link StripeNotConfiguredError}.
 *
 * ## Key resolution
 *
 * `STRIPE_SECRET_KEY` wins; `STRIPE_SECRET_KEY_TEST` is the fallback. Both
 * are absent today — see `scripts/env-manifest.json` for where they live
 * once Stripe is provisioned (task 1.1).
 *
 * The reported mode comes from the key's own prefix, NOT from which variable
 * supplied it: a `sk_test_…` pasted into `STRIPE_SECRET_KEY` is still test
 * mode, and reporting it as live would be the more dangerous lie. Anything
 * that isn't recognisably a live key reads as `'test'`, so a malformed value
 * can never be mistaken for "we are charging real cards".
 *
 * ## Secret handling
 *
 * The key is never logged, never returned, never embedded in an error
 * message, and never exported — not in full and not as a fragment. The only
 * thing that leaves this module is the constructed client and the coarse
 * mode enum. Callers that want to explain themselves in a log line should
 * log `stripeMode()`, which is safe by construction.
 */
import Stripe from 'stripe';

/**
 * Stripe api version this codebase is typed against.
 *
 * Pinned deliberately: `stripe@22.4.0`'s TypeScript definitions describe
 * exactly one api version (its `StripeConfig.apiVersion` is typed as the
 * literal `LatestApiVersion`), so the pin and the SDK version move together
 * on every upgrade. Leaving it unset would silently follow the Stripe
 * account's dashboard-configured default, which can drift under us without
 * a deploy.
 *
 * Sourced from `node_modules/stripe/cjs/apiVersion.d.ts` — re-check it when
 * bumping the SDK.
 */
export const STRIPE_API_VERSION = '2026-07-29.dahlia';

/**
 * Default per-request timeout, in milliseconds.
 *
 * The SDK's own default is 80 seconds, which is unusable inside a request
 * handler — a Stripe incident would pin our worker threads until the client
 * gave up long after the browser did. Ten seconds is generous for the
 * single-object calls we make and still bounded well inside any sane proxy
 * timeout. Latency-critical call sites (signup) pass a tighter per-request
 * override rather than lowering this for everyone.
 */
export const STRIPE_TIMEOUT_MS = 10_000;

/** Which Stripe account a configured key points at, or that none is set. */
export type StripeMode = 'live' | 'test' | 'unconfigured';

/**
 * Thrown when a caller demands a client and no key is configured.
 *
 * Deliberately explicit rather than a generic `TypeError` from the SDK: this
 * is a *deployment* error (a missing env var), not a bug in the calling code,
 * and the message has to say which variable to set. It carries no part of any
 * key — there is none to carry.
 */
export class StripeNotConfiguredError extends Error {
  readonly code = 'stripe_not_configured';

  constructor() {
    super(
      'stripe is not configured: set STRIPE_SECRET_KEY (or STRIPE_SECRET_KEY_TEST)',
    );
    this.name = 'StripeNotConfiguredError';
  }
}

/**
 * Read the configured secret, or `null`. Private — the value must not leave
 * this module.
 *
 * Trimmed because a deploy platform that stores an empty or whitespace-only
 * value (Railway happily does) would otherwise hand the SDK a blank key and
 * turn every call into a 401 instead of the clean "unconfigured" skip.
 */
function resolveSecretKey(): string | null {
  const live = process.env.STRIPE_SECRET_KEY?.trim();
  if (live) return live;
  const test = process.env.STRIPE_SECRET_KEY_TEST?.trim();
  if (test) return test;
  return null;
}

/**
 * Which Stripe account the current environment is wired to.
 *
 * Safe to log — it reveals nothing beyond live-vs-test, and it is the one
 * piece of Stripe configuration that call sites legitimately want in their
 * diagnostics.
 */
export function stripeMode(): StripeMode {
  const key = resolveSecretKey();
  if (!key) return 'unconfigured';
  // `sk_` = standard secret key, `rk_` = restricted key. Everything else
  // (including a malformed value) is treated as test — the safe direction.
  return key.startsWith('sk_live_') || key.startsWith('rk_live_') ? 'live' : 'test';
}

/** True when a Stripe call would actually reach Stripe. */
export function isStripeConfigured(): boolean {
  return resolveSecretKey() !== null;
}

// Cached across requests. `cachedKey` exists so a key rotated in a running
// process (or swapped between tests) rebuilds the client instead of silently
// authenticating with the old credential.
let cachedKey: string | null = null;
let cachedClient: Stripe | null = null;

/**
 * The shared Stripe client.
 *
 * @throws {StripeNotConfiguredError} when no key is configured. Callers on a
 * best-effort path should test with {@link isStripeConfigured} or use
 * {@link getStripeOrNull} instead of catching this.
 */
export function getStripe(): Stripe {
  const key = resolveSecretKey();
  if (!key) throw new StripeNotConfiguredError();

  if (cachedClient && cachedKey === key) return cachedClient;

  cachedClient = new Stripe(key, {
    apiVersion: STRIPE_API_VERSION,
    typescript: true,
    timeout: STRIPE_TIMEOUT_MS,
    // The SDK default is 1. Kept explicit because the retries are what make
    // a call safely repeatable, and because call sites that must not retry
    // (signup) override it per request — that override only reads as
    // deliberate if the baseline is stated here.
    maxNetworkRetries: 1,
    appInfo: { name: 'owlette', url: 'https://owlette.app' },
  });
  cachedKey = key;
  return cachedClient;
}

/**
 * The shared Stripe client, or `null` when Stripe is not configured.
 *
 * For best-effort paths (signup customer minting) where "no Stripe yet" is a
 * normal state to skip, not an error to handle.
 */
export function getStripeOrNull(): Stripe | null {
  return isStripeConfigured() ? getStripe() : null;
}
