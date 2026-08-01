/**
 * Stripe customer linking (billing-system wave 1.2).
 *
 * Pairs a `customers/{uid}` billing doc with a Stripe customer object and
 * writes the id back as `stripeCustomerId`. Called on the signup path by
 * `bootstrapUser.server.ts`, and mirrored by
 * `scripts/backfill-stripe-customers.mjs` for accounts that predate it.
 *
 * ## The uid contract
 *
 * **Every Stripe customer owlette creates carries `metadata.uid`.** The
 * webhook handler (wave 1.3) resolves an incoming event back to an account
 * from that metadata first, falling back to a Firestore query on
 * `stripeCustomerId`. Two consequences are load-bearing here:
 *
 *  1. When we adopt a pre-existing Stripe customer found by email, we stamp
 *     `metadata.uid` onto it if it has none — otherwise every webhook for
 *     that customer would take the slow fallback path forever.
 *  2. We refuse to adopt a customer whose `metadata.uid` names a *different*
 *     account. Reusing it would point two accounts at one Stripe customer and
 *     the webhook would credit the wrong one. We mint a fresh customer
 *     instead.
 *
 * ## Never throws
 *
 * Same posture as `mintCustomerDoc()`: billing bookkeeping must not be able
 * to fail a signup. Every failure is logged (never with any part of a key)
 * and reported as `null`; the backfill script is the repair path, and the
 * logged error reaches Sentry in production.
 */
import type { Firestore } from 'firebase-admin/firestore';
import type Stripe from 'stripe';
import { getStripeOrNull, stripeMode } from '@/lib/stripe.server';
import logger from '@/lib/logger';

/**
 * Per-request timeout for the signup path, in milliseconds.
 *
 * Tighter than the client-wide `STRIPE_TIMEOUT_MS` because this runs inline
 * in account creation: a Stripe incident must cost a new user a couple of
 * seconds, not ten. Paired with `maxNetworkRetries: 0` so the worst case is
 * one round trip, not one-plus-backoff.
 */
const SIGNUP_TIMEOUT_MS = 4_000;

/**
 * Request options for calls made while a user waits on signup. The bounded
 * timeout is the whole reason this exists — see {@link SIGNUP_TIMEOUT_MS}.
 */
const SIGNUP_REQUEST_OPTIONS: Stripe.RequestOptions = {
  timeout: SIGNUP_TIMEOUT_MS,
  maxNetworkRetries: 0,
};

export interface LinkStripeCustomerInput {
  db: Firestore;
  /** Account uid — the `customers/{uid}` key and the `metadata.uid` value. */
  uid: string;
  /** The account's verified email, as persisted on `users/{uid}`. */
  email: string;
  /**
   * Bound the Stripe calls to the signup latency budget. `true` on the
   * bootstrap path; the backfill script (which nobody is waiting on) has no
   * equivalent and simply uses the client default.
   */
  signupPath?: boolean;
}

/**
 * Read `metadata.uid` off a Stripe customer, or `null` when unset.
 * Stripe metadata values are always strings, but an empty one is as good as
 * absent.
 */
function metadataUid(customer: Stripe.Customer): string | null {
  const value = customer.metadata?.uid;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Find a Stripe customer already carrying this email.
 *
 * Uses `customers.list({ email })` rather than `customers.search()`: search
 * runs against an index that lags writes by up to a minute, so a retried
 * signup could search, miss, and create a duplicate. The list filter reads
 * straight through and is strongly consistent — exactly what an idempotency
 * check needs.
 *
 * Stripe's email filter is case-sensitive, and deleted customers are excluded
 * from list results. We look up with the same string we would create with, so
 * lookup and create can never disagree about casing.
 */
async function findByEmail(
  stripe: Stripe,
  email: string,
  requestOptions: Stripe.RequestOptions,
): Promise<Stripe.Customer | null> {
  const found = await stripe.customers.list({ email, limit: 1 }, requestOptions);
  return found.data[0] ?? null;
}

/**
 * Resolve the Stripe customer for an account: reuse one found by email, or
 * create it. Throws — the never-throw boundary is {@link linkStripeCustomer}.
 */
async function resolveStripeCustomer(
  stripe: Stripe,
  uid: string,
  email: string,
  requestOptions: Stripe.RequestOptions,
): Promise<Stripe.Customer> {
  const existing = await findByEmail(stripe, email, requestOptions);

  if (existing) {
    const ownerUid = metadataUid(existing);

    if (ownerUid === uid) return existing;

    if (ownerUid === null) {
      // Adopted: a customer created outside this code path (Stripe dashboard,
      // an import, a manual invoice). Stamp the uid so the webhook's primary
      // resolution works for it from here on.
      return stripe.customers.update(
        existing.id,
        { metadata: { uid } },
        requestOptions,
      );
    }

    // Claimed by a different account. Falling through to create is the only
    // safe answer — see the uid contract in the file header.
    logger.warn('stripe customer with this email belongs to another account', {
      context: 'stripeCustomer',
      data: { uid, stripeCustomerId: existing.id, ownerUid },
    });
  }

  return stripe.customers.create(
    { email, metadata: { uid } },
    {
      ...requestOptions,
      // Collapses a double-submitted signup (or a client retry) onto one
      // customer for 24h — the window Stripe keeps idempotency keys.
      idempotencyKey: `owlette-customer-${uid}`,
    },
  );
}

/**
 * Link `customers/{uid}` to a Stripe customer and persist the id.
 *
 * Returns the `stripeCustomerId` on success, or `null` when the link was
 * skipped (Stripe unconfigured) or failed (logged, never thrown).
 *
 * The write uses `update()`, not `set(..., { merge: true })`, on purpose: if
 * the `customers/{uid}` doc is missing, this must fail rather than conjure a
 * partial doc with only `stripeCustomerId` on it. A partial doc would satisfy
 * `backfill-customers.mjs`'s existence check and permanently lock that
 * account out of getting its trial clock and billing fields.
 */
export async function linkStripeCustomer(
  input: LinkStripeCustomerInput,
): Promise<string | null> {
  const { db, uid, email, signupPath = false } = input;

  const stripe = getStripeOrNull();
  if (!stripe) {
    // The normal state until the Stripe account is provisioned (task 1.1).
    // Debug level so it doesn't page anyone every time somebody signs up.
    logger.debug('stripe not configured — skipping customer link', {
      context: 'stripeCustomer',
      data: { uid },
    });
    return null;
  }

  try {
    const requestOptions = signupPath ? SIGNUP_REQUEST_OPTIONS : {};
    const customer = await resolveStripeCustomer(stripe, uid, email, requestOptions);

    await db.collection('customers').doc(uid).update({
      stripeCustomerId: customer.id,
    });

    logger.info('linked stripe customer', {
      context: 'stripeCustomer',
      data: { uid, stripeCustomerId: customer.id, mode: stripeMode() },
    });
    return customer.id;
  } catch (err) {
    logger.error('failed to link stripe customer', {
      context: 'stripeCustomer',
      data: {
        uid,
        mode: stripeMode(),
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return null;
  }
}
