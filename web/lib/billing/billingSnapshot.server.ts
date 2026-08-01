/**
 * Billing snapshot resolution (billing-system wave 0.5).
 *
 * The one place that walks `sites/{siteId}` → `owner` → `customers/{owner}`
 * and turns it into the two facts every gate needs: the account's effective
 * `billingState` and the site's effective `siteTier`.
 *
 * **Why this is a separate leaf module from `billingGate.server.ts`.** The
 * gates throw `ApiAuthError`, which lives in `@/lib/apiAuth.server` — so
 * `billingGate.server.ts` has to import the auth module. The auth layer in
 * turn needs the same snapshot to enforce the public-API lockout, and a
 * direct `apiAuth ⇄ billingGate` pair would be an import cycle. Keeping the
 * resolution (and the error vocabulary both sides share) in a dependency-free
 * leaf keeps the module graph acyclic: `apiAuth → billingSnapshot` and
 * `billingGate → apiAuth, billingSnapshot`.
 *
 * Fail-open posture, inherited from `resolveBillingState()` and
 * `getSiteTier()`: an account we can't resolve is treated as trialing rather
 * than locked out. Locking a paying customer out of their fleet over our own
 * data bug is the worse of the two failures.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  resolveBillingState,
  type BillingStateSource,
} from '@/lib/billing/billingState';
import { getSiteTier, type SiteTier } from '@/lib/siteTier';
import type { BillingState } from '@/lib/types/customer';

/**
 * Stable machine-readable code for the trial/subscription lockout. Public
 * contract — clients (CLI, SDK) branch on it; see the API error catalog.
 */
export const TRIAL_EXPIRED_CODE = 'trial_expired';

/** Stable machine-readable code for a pro-only feature hit on a core site. */
export const TIER_INSUFFICIENT_CODE = 'tier_insufficient';

/** Billing states that lock an account out. See plan.md's lockout matrix. */
export type LockedBillingState = Extract<BillingState, 'expired' | 'canceled'>;

export interface BillingSnapshot {
  siteId: string;
  /**
   * The site's `owner` uid — the billing customer. `null` for a site doc
   * with no owner field (legacy or partially-written); such a site has no
   * customer to resolve and reads as `'trialing'`.
   */
  ownerUid: string | null;
  /** Effective account state, resolved via `resolveBillingState()`. */
  billingState: BillingState;
  /** Effective site tier, resolved via `getSiteTier()`. */
  siteTier: SiteTier;
}

export interface BillingSnapshotOptions {
  /** Inject a Firestore instance; tests pass a fake, production omits. */
  db?: Firestore;
  /** Inject a clock; tests pass a fixed value, production omits. */
  now?: Date;
}

/** True when this state locks the account out of gated capabilities. */
export function isLockedOut(state: BillingState): state is LockedBillingState {
  return state === 'expired' || state === 'canceled';
}

/**
 * Human-readable `detail` for the 402. Distinguishes the two lockout causes
 * because the remedy reads differently to a customer who never converted vs.
 * one whose subscription ended.
 */
export function billingLockoutDetail(state: LockedBillingState): string {
  return state === 'canceled'
    ? 'this subscription was canceled; choose a plan to restore access'
    : 'this free trial has ended; choose a plan to restore access';
}

/** Human-readable `detail` for the 403 on a pro-only feature. */
export function tierInsufficientDetail(): string {
  return 'this feature requires the pro tier; upgrade the site to pro to continue';
}

/**
 * Resolve a site's billing snapshot.
 *
 * Returns `null` when the site doc does not exist — callers decide whether
 * that is a 404 (`billingGate`'s gates) or a no-op (the auth layer, where
 * `assertUserHasSiteAccess()` has already 404'd on a missing site).
 *
 * A missing `customers/{owner}` doc is NOT an error: it means an account
 * that predates wave 0.1's minting and the backfill. `resolveBillingState()`
 * maps that to `'trialing'`, which is the documented pre-go-live posture.
 */
export async function getBillingSnapshot(
  siteId: string,
  options: BillingSnapshotOptions = {},
): Promise<BillingSnapshot | null> {
  const db = options.db ?? getAdminDb();

  const siteSnap = await db.collection('sites').doc(siteId).get();
  if (!siteSnap.exists) return null;

  const siteData = siteSnap.data() ?? {};
  const siteTier = getSiteTier(siteData);
  const rawOwner = siteData.owner;
  const ownerUid = typeof rawOwner === 'string' && rawOwner.length > 0 ? rawOwner : null;

  if (!ownerUid) {
    // No owner means no billing customer to look up. Fail open rather than
    // locking every member of an ownerless site out of the site.
    return { siteId, ownerUid: null, billingState: 'trialing', siteTier };
  }

  const customerSnap = await db.collection('customers').doc(ownerUid).get();
  const customer = customerSnap.exists
    ? (customerSnap.data() as BillingStateSource | undefined) ?? null
    : null;

  return {
    siteId,
    ownerUid,
    billingState: resolveBillingState(customer, options.now),
    siteTier,
  };
}
