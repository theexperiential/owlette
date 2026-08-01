/**
 * Billing-state resolver (billing-system wave 0.2).
 *
 * The single answer to "what may this account do right now?". Every gate —
 * the pro-only feature checks, the control-plane lockout, the trial banner,
 * the api-key auth layer — resolves through here so the trial/subscription
 * precedence rules live in exactly one place.
 *
 * Pure and dependency-free (same posture as `@/lib/siteTier`): no Firestore
 * imports, no clock of its own beyond an injectable default, so it can be
 * called from server actions, route handlers, cloud-function code, and
 * client hooks alike.
 */
import type {
  BillingState,
  BillingTimestamp,
  SubscriptionStatus,
} from '@/lib/types/customer';

/**
 * Narrow customer shape — accepts anything carrying the two fields the
 * decision depends on, and tolerates raw strings so a doc read straight
 * out of Firestore (or an admin payload) can be passed without casting.
 */
export interface BillingStateSource {
  subscriptionStatus?: SubscriptionStatus | string | null;
  trialEndsAt?: BillingTimestamp | null;
}

/**
 * Extract epoch milliseconds from any {@link BillingTimestamp} shape, or
 * `null` when the value can't be read as a time.
 *
 * A local converter rather than `firestoreTsToMs` from
 * `@/hooks/useFirestore`: that module is `'use client'` and importing its
 * runtime would drag the client Firebase SDK into every server caller.
 *
 * Exported because the trial lifecycle sweep (wave 2.2) has to read the same
 * `trialEndsAt` field to compute reminder milestones — a second converter
 * would be a second set of shape bugs to keep in sync.
 */
export function billingTimestampToMillis(ts: BillingTimestamp): number | null {
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null;
  if (ts instanceof Date) {
    const ms = ts.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof ts === 'object' && ts !== null) {
    const v = ts as {
      toMillis?: () => number;
      seconds?: number;
      _seconds?: number;
    };
    if (typeof v.toMillis === 'function') {
      try {
        const ms = v.toMillis();
        return Number.isFinite(ms) ? ms : null;
      } catch {
        return null;
      }
    }
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    if (typeof v._seconds === 'number') return v._seconds * 1000;
  }
  return null;
}

/**
 * Resolve an account's effective billing state.
 *
 * Precedence — a subscription, once it exists, outranks the trial clock:
 *
 * - `'active'` / `'past_due'` → `'active'`. A past-due account stays fully
 *   functional on purpose: Stripe's dunning (retries + emails) owns the
 *   recovery window, and cutting service off the first failed charge would
 *   punish an expired card rather than a non-paying customer. Stripe moves
 *   the subscription to `canceled` when dunning gives up, and that lands
 *   here as a lockout.
 * - `'canceled'` → `'canceled'` (same lockout matrix as `'expired'`;
 *   reactivation is a fresh checkout).
 * - `'incomplete'` → falls through to the trial clock. Checkout was started
 *   but never completed, so nothing has been paid for; the trial is still
 *   the only thing granting access.
 * - `null` / absent / any unrecognised string → falls through to the trial
 *   clock. Unrecognised is deliberate: the webhook handler (wave 1.3) is
 *   responsible for normalising Stripe's wider status enum, and a status we
 *   don't understand must not silently read as a paid subscription.
 *
 * Trial clock:
 *
 * - `trialEndsAt === null` → `'trialing'`. The pre-go-live sentinel: beta
 *   accounts whose clock hasn't been started yet (see `Customer.trialEndsAt`).
 * - `trialEndsAt` strictly in the future → `'trialing'`.
 * - otherwise (including exactly `now`) → `'expired'`.
 *
 * An unparseable `trialEndsAt` resolves to `'trialing'` — the same fail-open
 * posture as `getSiteTier()`'s unknown-value fallback. A corrupt timestamp is
 * our data bug, and locking a customer out of their fleet over it is the
 * worse of the two failures.
 */
export function resolveBillingState(
  customer: BillingStateSource | null | undefined,
  now: Date = new Date(),
): BillingState {
  const status = customer?.subscriptionStatus;
  if (status === 'active' || status === 'past_due') return 'active';
  if (status === 'canceled') return 'canceled';

  const trialEndsAt = customer?.trialEndsAt;
  if (trialEndsAt == null) return 'trialing';

  const endsAtMs = billingTimestampToMillis(trialEndsAt);
  if (endsAtMs === null) return 'trialing';

  return endsAtMs > now.getTime() ? 'trialing' : 'expired';
}
