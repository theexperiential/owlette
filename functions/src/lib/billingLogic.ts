/**
 * Pure billing-state resolution for the functions runtime (billing sprint
 * wave 2.6).
 *
 * **This is a deliberate mirror of `web/lib/billing/billingState.ts`.**
 * functions/ cannot import from web/ (separate tsconfig, separate deploy
 * artifact), the same reason `quotaLogic.BETA_DEFAULT_TIER` mirrors
 * `web/lib/siteTier.ts`. The two must stay in sync: a divergent resolver
 * would let the dashboard show an account as paid while the retry pump
 * refuses to deliver its webhooks, or the reverse.
 *
 * Only the half functions/ needs is mirrored — "is this account locked out?".
 * Trial countdowns, warning headers, and tier resolution stay web-side.
 */

/** Mirrors `BillingState` in `web/lib/types/customer.ts`. */
export type BillingState = 'trialing' | 'active' | 'expired' | 'canceled';

/** The two states that pause gated capabilities. See plan.md's lockout matrix. */
export type LockedBillingState = Extract<BillingState, 'expired' | 'canceled'>;

/**
 * The fields of a `customers/{uid}` doc the decision depends on. Firestore
 * data is untyped here, so both arrive as `unknown` and are narrowed below.
 */
export interface BillingStateSource {
  subscriptionStatus?: unknown;
  trialEndsAt?: unknown;
}

/**
 * Epoch milliseconds from any timestamp shape a `customers` doc can hold, or
 * `null` when the value can't be read as a time.
 *
 * Mirrors `billingTimestampToMillis()` web-side. The admin SDK hands back a
 * `Timestamp` with `toMillis()`; the `seconds` / `_seconds` fallbacks cover
 * docs written through the REST API or a raw export.
 */
export function billingTimestampToMillis(ts: unknown): number | null {
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
    const v = ts as { toMillis?: () => number; seconds?: number; _seconds?: number };
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
 * Byte-for-byte the same precedence as `resolveBillingState()` web-side —
 * read that function's doc comment for the reasoning behind each rung:
 * `active` / `past_due` → active, `canceled` → canceled, everything else
 * (including `incomplete`, `null`, and any unrecognised string) falls
 * through to the trial clock, and an absent or unparseable `trialEndsAt`
 * fails open to `trialing`.
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

/** True when this state locks the account out of gated capabilities. */
export function isLockedOut(state: BillingState): state is LockedBillingState {
  return state === 'expired' || state === 'canceled';
}

/**
 * The state pausing an account's webhook delivery, or `null` to deliver.
 *
 * State only, never tier — a `core` account is paid up, and pausing its
 * delivery is *creation*'s gate to enforce, not the dispatcher's. Same line
 * the web sender draws (`web/lib/billing/webhookDelivery.server.ts`).
 */
export function webhookDeliveryPausedBy(
  customer: BillingStateSource | null | undefined,
  now: Date = new Date(),
): LockedBillingState | null {
  const state = resolveBillingState(customer, now);
  return isLockedOut(state) ? state : null;
}
