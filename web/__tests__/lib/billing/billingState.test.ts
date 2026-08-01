/**
 * @jest-environment node
 *
 * Tests for `web/lib/billing/billingState.ts` (billing-system wave 0.2).
 *
 * Every gate in the billing system resolves through this one function, so
 * the matrix here is deliberately exhaustive: each subscription status,
 * each trial-clock outcome, and the precedence between the two.
 */
import { resolveBillingState } from '@/lib/billing/billingState';
import { TRIAL_LENGTH_DAYS, newCustomerDoc } from '@/lib/types/customer';

const NOW = new Date('2026-08-01T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const future = new Date(NOW.getTime() + DAY_MS);
const past = new Date(NOW.getTime() - DAY_MS);

describe('resolveBillingState — subscription status wins when present', () => {
  it('returns "active" for an active subscription, even past the trial end', () => {
    expect(
      resolveBillingState({ subscriptionStatus: 'active', trialEndsAt: past }, NOW),
    ).toBe('active');
  });

  it('returns "active" for past_due — Stripe dunning owns the recovery window', () => {
    // Deliberate: a failed charge must not cut a customer off their fleet.
    // Stripe retries and emails; if dunning gives up it flips the
    // subscription to canceled, and THAT lands as a lockout below.
    expect(
      resolveBillingState({ subscriptionStatus: 'past_due', trialEndsAt: past }, NOW),
    ).toBe('active');
  });

  it('returns "canceled" for a canceled subscription, even inside a live trial', () => {
    expect(
      resolveBillingState({ subscriptionStatus: 'canceled', trialEndsAt: future }, NOW),
    ).toBe('canceled');
  });

  it('falls through to the trial clock for "incomplete" — nothing was paid for', () => {
    expect(
      resolveBillingState({ subscriptionStatus: 'incomplete', trialEndsAt: future }, NOW),
    ).toBe('trialing');
    expect(
      resolveBillingState({ subscriptionStatus: 'incomplete', trialEndsAt: past }, NOW),
    ).toBe('expired');
  });

  it('falls through to the trial clock for an unrecognised Stripe status', () => {
    // Stripe's enum is wider than ours ('unpaid', 'paused',
    // 'incomplete_expired', …); the webhook handler (wave 1.3) normalises
    // it. A status we don't understand must never read as "paid".
    expect(
      resolveBillingState({ subscriptionStatus: 'unpaid', trialEndsAt: past }, NOW),
    ).toBe('expired');
    expect(
      resolveBillingState({ subscriptionStatus: 'paused', trialEndsAt: future }, NOW),
    ).toBe('trialing');
  });
});

describe('resolveBillingState — trial clock', () => {
  it('returns "trialing" when trialEndsAt is null (pre-go-live sentinel)', () => {
    // Backfilled beta accounts carry null: "clock not started". It must
    // never read as expired — task 5.3 stamps a real date at T0.
    expect(
      resolveBillingState({ subscriptionStatus: null, trialEndsAt: null }, NOW),
    ).toBe('trialing');
  });

  it('returns "trialing" when trialEndsAt is absent entirely', () => {
    expect(resolveBillingState({}, NOW)).toBe('trialing');
  });

  it('returns "trialing" for a null/undefined customer', () => {
    // A missing customers doc (mint failed, backfill not run yet) must not
    // lock the account out — the doc's absence is our bug, not theirs.
    expect(resolveBillingState(null, NOW)).toBe('trialing');
    expect(resolveBillingState(undefined, NOW)).toBe('trialing');
  });

  it('returns "trialing" while trialEndsAt is in the future', () => {
    expect(resolveBillingState({ trialEndsAt: future }, NOW)).toBe('trialing');
  });

  it('returns "expired" once trialEndsAt is in the past', () => {
    expect(resolveBillingState({ trialEndsAt: past }, NOW)).toBe('expired');
  });

  it('returns "expired" at exactly trialEndsAt — the boundary is inclusive of expiry', () => {
    // Strictly-in-the-future is the rule; equal instants are over.
    expect(resolveBillingState({ trialEndsAt: new Date(NOW) }, NOW)).toBe('expired');
  });

  it('returns "trialing" one millisecond before trialEndsAt', () => {
    const oneMsLeft = new Date(NOW.getTime() + 1);
    expect(resolveBillingState({ trialEndsAt: oneMsLeft }, NOW)).toBe('trialing');
  });

  it('defaults `now` to the current time when the caller omits it', () => {
    expect(
      resolveBillingState({ trialEndsAt: new Date(Date.now() + DAY_MS) }),
    ).toBe('trialing');
    expect(
      resolveBillingState({ trialEndsAt: new Date(Date.now() - DAY_MS) }),
    ).toBe('expired');
  });
});

describe('resolveBillingState — timestamp shapes', () => {
  // A customers doc can be read through the admin SDK, the client SDK, or
  // a JSON API response; each hands back a different timestamp shape.
  it('accepts epoch milliseconds', () => {
    expect(resolveBillingState({ trialEndsAt: future.getTime() }, NOW)).toBe('trialing');
    expect(resolveBillingState({ trialEndsAt: past.getTime() }, NOW)).toBe('expired');
  });

  it('accepts an ISO string', () => {
    expect(resolveBillingState({ trialEndsAt: future.toISOString() }, NOW)).toBe('trialing');
    expect(resolveBillingState({ trialEndsAt: past.toISOString() }, NOW)).toBe('expired');
  });

  it('accepts a Timestamp-like object with toMillis()', () => {
    expect(
      resolveBillingState({ trialEndsAt: { toMillis: () => future.getTime() } }, NOW),
    ).toBe('trialing');
    expect(
      resolveBillingState({ trialEndsAt: { toMillis: () => past.getTime() } }, NOW),
    ).toBe('expired');
  });

  it('accepts a plain {seconds} pair from a rehydrated snapshot', () => {
    expect(
      resolveBillingState({ trialEndsAt: { seconds: future.getTime() / 1000 } }, NOW),
    ).toBe('trialing');
    expect(
      resolveBillingState({ trialEndsAt: { seconds: past.getTime() / 1000 } }, NOW),
    ).toBe('expired');
  });

  it('accepts a legacy admin-SDK {_seconds} pair from a JSON response', () => {
    expect(
      resolveBillingState({ trialEndsAt: { _seconds: future.getTime() / 1000 } }, NOW),
    ).toBe('trialing');
    expect(
      resolveBillingState({ trialEndsAt: { _seconds: past.getTime() / 1000 } }, NOW),
    ).toBe('expired');
  });

  it('fails open to "trialing" on an unparseable timestamp', () => {
    // A corrupt timestamp is our data bug; locking a customer out of their
    // fleet over it is the worse of the two failure modes.
    expect(resolveBillingState({ trialEndsAt: 'not-a-date' }, NOW)).toBe('trialing');
    expect(resolveBillingState({ trialEndsAt: Number.NaN }, NOW)).toBe('trialing');
    expect(
      resolveBillingState(
        {
          trialEndsAt: {
            toMillis: () => {
              throw new Error('boom');
            },
          },
        },
        NOW,
      ),
    ).toBe('trialing');
    expect(
      resolveBillingState({ trialEndsAt: {} as { seconds: number } }, NOW),
    ).toBe('trialing');
  });
});

describe('resolveBillingState — freshly minted customer docs', () => {
  it('resolves a signup-minted doc as trialing for the whole trial window', () => {
    const doc = newCustomerDoc(NOW);
    expect(resolveBillingState(doc, NOW)).toBe('trialing');

    const lastMoment = new Date(NOW.getTime() + TRIAL_LENGTH_DAYS * DAY_MS - 1);
    expect(resolveBillingState(doc, lastMoment)).toBe('trialing');
  });

  it('resolves a signup-minted doc as expired the instant the trial ends', () => {
    const doc = newCustomerDoc(NOW);
    const endsAt = new Date(NOW.getTime() + TRIAL_LENGTH_DAYS * DAY_MS);
    expect(resolveBillingState(doc, endsAt)).toBe('expired');
  });
});
