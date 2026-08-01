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
  billingTimestampToMillis,
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

/**
 * Advisory response header carrying the trial countdown to api-key clients
 * (billing-system wave 3.3). Public contract — `@owlette/cli` prints it to
 * stderr and the SDKs surface it through an `onBillingWarning` callback, so
 * the name and the value format below are both frozen.
 */
export const BILLING_WARNING_HEADER = 'X-Owlette-Billing-Warning';

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
  /**
   * End of the app-managed trial as epoch milliseconds, or `null` when there
   * is no readable clock. `null` covers three cases that all mean the same
   * thing to a caller — **do not advertise a trial deadline**:
   *
   * - no `customers/{uid}` doc (account predates wave 0.1's minting),
   * - `trialEndsAt: null`, the documented pre-go-live sentinel (task 5.3
   *   stamps the real date at T0),
   * - an unparseable value, which `resolveBillingState()` already fails open
   *   on.
   *
   * Kept separate from `billingState` because the state alone can't answer
   * "when": a `'trialing'` account may legitimately have no clock yet.
   */
  trialEndsAt: number | null;
}

/**
 * Account-level counterpart to {@link BillingSnapshot}, for gates that have
 * no single site to key off — api-key creation is the whole of it today.
 */
export interface AccountBillingSnapshot {
  /** The billing customer's uid (`customers/{uid}`). */
  uid: string;
  /** Effective account state, resolved via `resolveBillingState()`. */
  billingState: BillingState;
  /**
   * Effective account tier: `'pro'` when **any** site the account owns
   * resolves pro, else `'core'`.
   *
   * "Any" rather than "all" because the tier flag lives on the site doc and
   * an account may hold a mixed portfolio. Owning one pro site is what
   * entitles the account to the pro feature set, so the strictest reading
   * ("every site must be pro") would take the API away from exactly the
   * customers paying for it.
   *
   * An account that owns **no** sites resolves `'core'` — there is no pro
   * entitlement to point at. That is not a fail-closed edge case in
   * practice: `'trialing'` short-circuits ahead of the tier check, and an
   * account with a paid subscription and zero sites has nothing an api key
   * could address anyway.
   */
  accountTier: SiteTier;
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
 * The `X-Owlette-Billing-Warning` value for a snapshot, or `null` when the
 * response should carry no warning.
 *
 * Emitted only while `'trialing'` **and** a real `trialEndsAt` exists:
 *
 * - `'active'` (subscribed, incl. `past_due`) — nothing to warn about.
 * - `'expired'` / `'canceled'` — the request is already answering 402
 *   `trial_expired` with the remedy in its body; a duplicate advisory on a
 *   response the caller can't get anyway would be noise.
 * - `'trialing'` with `trialEndsAt === null` — the pre-go-live sentinel.
 *   Deliberately silent: announcing a deadline we have not set would leak
 *   the trial machinery to beta accounts before billing exists, and task 5.3
 *   is what turns the clock on.
 *
 * The value is frozen public contract (see {@link BILLING_WARNING_HEADER}):
 * `trial ends <ISO-8601 UTC instant>; choose a plan to keep API access`.
 * Full `toISOString()` rather than a date-only form so the deadline carries
 * no timezone ambiguity, matching how every other timestamp crosses this API.
 */
export function billingWarningFor(snapshot: BillingSnapshot): string | null {
  if (snapshot.billingState !== 'trialing') return null;
  if (snapshot.trialEndsAt === null) return null;
  return `trial ends ${new Date(snapshot.trialEndsAt).toISOString()}; choose a plan to keep API access`;
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
    return { siteId, ownerUid: null, billingState: 'trialing', siteTier, trialEndsAt: null };
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
    trialEndsAt:
      customer?.trialEndsAt == null ? null : billingTimestampToMillis(customer.trialEndsAt),
  };
}

/**
 * Resolve an account's billing snapshot directly from its uid.
 *
 * Unlike {@link getBillingSnapshot} there is no `null` return: an account
 * with no `customers/{uid}` doc is the documented pre-go-live posture, not a
 * missing resource, and `resolveBillingState()` maps it to `'trialing'`.
 *
 * Costs one doc read plus one `sites where owner == uid` query. Only call it
 * from account-scoped gates — a site-scoped caller already knows its site and
 * should use {@link getBillingSnapshot}, which is strictly cheaper.
 */
export async function getAccountBillingSnapshot(
  uid: string,
  options: BillingSnapshotOptions = {},
): Promise<AccountBillingSnapshot> {
  const db = options.db ?? getAdminDb();

  const customerSnap = await db.collection('customers').doc(uid).get();
  const customer = customerSnap.exists
    ? (customerSnap.data() as BillingStateSource | undefined) ?? null
    : null;

  const ownedSites = await db.collection('sites').where('owner', '==', uid).get();
  const accountTier: SiteTier = ownedSites.docs.some(
    (doc) => getSiteTier(doc.data()) === 'pro',
  )
    ? 'pro'
    : 'core';

  return {
    uid,
    billingState: resolveBillingState(customer, options.now),
    accountTier,
  };
}
