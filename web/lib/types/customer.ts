/**
 * Billing customer doc shape (billing-system wave 0.1).
 *
 * Owns the `customers/{uid}` document that pairs 1:1 with a `users/{uid}`
 * account. Kept tiny and dependency-free — no Firestore imports — so the
 * server actions, the pure billing-state resolver, and any future client
 * hook can all import it without dragging SDK wiring across the boundary.
 *
 * **Keyed by the owning user's uid, not an org id.** `plan.md` writes the
 * collection as `customers/{orgId}`, but this codebase has no org entity:
 * tenancy is sites + users, and every site doc carries `owner: <uid>`. The
 * account owner IS the billing customer, so the uid is the customer key.
 * Do not add an org layer to satisfy the plan's wording.
 *
 * Stripe is authoritative for subscription state once a subscription
 * exists; Firestore is authoritative for the app-managed trial (no card is
 * collected to start a trial, so no Stripe subscription exists yet). Every
 * field here is a mirror for fast reads — resolve the effective state with
 * `resolveBillingState()` from `@/lib/billing/billingState`, never by
 * reading `billingState` alone.
 */

/** Free-trial length, in days. The single source of the 14-day number. */
export const TRIAL_LENGTH_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Every shape a timestamp field on a customers doc can arrive in: an
 * admin- or client-SDK `Timestamp` (both expose `toMillis()`), a `Date`
 * (what we write, and what tests inject), epoch milliseconds, a plain
 * `{seconds}` / `{_seconds}` pair from JSON round-tripping across an API
 * boundary, or an ISO string.
 *
 * This deliberately mirrors `FirestoreTs` in `web/hooks/useFirestore.ts`
 * rather than importing it — that module is `'use client'` and pulls in
 * `firebase/firestore`, which would make every server-side importer of
 * this file carry the client SDK.
 */
export type BillingTimestamp =
  | Date
  | number
  | string
  | { toMillis: () => number }
  | { seconds: number; nanoseconds?: number }
  | { _seconds: number; _nanoseconds?: number };

/**
 * Subscription status mirrored from Stripe. Narrower than Stripe's own
 * enum on purpose — the webhook handler (wave 1.3) normalises Stripe's
 * wider set (`unpaid`, `paused`, `incomplete_expired`, …) down to these
 * four before writing. `null` means "no subscription yet" (trial, or
 * never converted).
 */
export type SubscriptionStatus = 'active' | 'past_due' | 'canceled' | 'incomplete';

/**
 * Effective lifecycle state. Derived — see `resolveBillingState()`. Stored
 * on the doc only as a cached mirror so list views don't have to run the
 * resolver per row.
 */
export type BillingState = 'trialing' | 'active' | 'expired' | 'canceled';

export interface Customer {
  /** Stripe customer id. Minted at conversion (wave 1.2); `null` until then. */
  stripeCustomerId: string | null;
  /** Stripe subscription id. `null` while trialing or after a hard cancel. */
  subscriptionId: string | null;
  /** Mirrored Stripe subscription status; `null` when no subscription exists. */
  subscriptionStatus: SubscriptionStatus | null;
  /**
   * End of the app-managed free trial.
   *
   * `null` is a meaningful sentinel: **"pre-go-live beta account — the
   * trial clock has not started"**. Accounts that existed before billing
   * went live are backfilled with `null` and treated as `trialing`
   * indefinitely; the go-live task (5.3) stamps them all with
   * `T0 + TRIAL_LENGTH_DAYS` on the announced date. New accounts get a
   * real timestamp at signup, so `null` never means "expired".
   */
  trialEndsAt: BillingTimestamp | null;
  /** Cached result of `resolveBillingState()` — never read this directly. */
  billingState: BillingState;
  /** End of the current Stripe billing period; `null` while trialing. */
  currentPeriodEnd: BillingTimestamp | null;
  /** Stripe payment-method id used for renewals; `null` until a card is added. */
  defaultPaymentMethod: string | null;
  /** Customer-supplied tax id (VAT / GST / …) forwarded to Stripe; `null` if unset. */
  taxId: string | null;
}

/**
 * Trial end for an account starting its clock at `now`. The one place the
 * `TRIAL_LENGTH_DAYS` → milliseconds conversion lives, so signup (0.1) and
 * the go-live stamp (5.3) can never drift apart.
 */
export function trialEndsAtFrom(now: Date): Date {
  return new Date(now.getTime() + TRIAL_LENGTH_DAYS * MS_PER_DAY);
}

/**
 * The customer doc a brand-new account is minted with: a live 14-day trial
 * clock and no Stripe linkage yet. Every field of {@link Customer} is
 * written explicitly — an absent field would be indistinguishable from a
 * partially-written doc during the backfill.
 *
 * `scripts/backfill-customers.mjs` hand-mirrors this shape (it's ESM and
 * can't import TypeScript); keep the field list there in sync.
 */
export function newCustomerDoc(now: Date): Customer {
  return {
    stripeCustomerId: null,
    subscriptionId: null,
    subscriptionStatus: null,
    trialEndsAt: trialEndsAtFrom(now),
    billingState: 'trialing',
    currentPeriodEnd: null,
    defaultPaymentMethod: null,
    taxId: null,
  };
}
