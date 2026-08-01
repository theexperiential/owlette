/**
 * Server-side billing gates (billing-system wave 0.5).
 *
 * The throwing half of the billing model: given a site id, decide whether
 * the request may proceed at all (`requireActiveBilling`) and whether it may
 * use a pro-only feature (`requirePro`). The read half —
 * `sites/{siteId}` → `owner` → `customers/{owner}` — lives in
 * `@/lib/billing/billingSnapshot.server` and is re-exported here so callers
 * have one import site.
 *
 * **Error shape.** These throw `ApiAuthError`, the same type
 * `requireScope()` / `assertUserHasSiteAccess()` throw, so every existing
 * converter already knows what to do with them:
 *
 *   - `authorizedHandler.server.ts` → `authErrorToResponse()`
 *   - `web/app/api/_shared.ts` → `resolveAuthOrProblem()` / `runScopeCheck()`
 *   - legacy routes → `catch (e) { if (e instanceof ApiAuthError) ... }`
 *
 * Both new codes render through the RFC 7807 envelope in `@/lib/apiErrors`:
 * `402 trial_expired` and `403 tier_insufficient`.
 *
 * **Trial = pro.** `'trialing'` passes both gates. That is the whole point of
 * the trial model — a customer evaluates the full product before choosing a
 * tier, so no trial account may ever see a `tier_insufficient`.
 *
 * **Where the gates are called.** Wave 0.5 wires only the public-API lockout
 * (see `requireApiKeyBilling` in `@/lib/apiAuth.server`). Per-route pro
 * gating and the control-plane lockout are wave 0.6 — these helpers are the
 * substrate it calls, not the wiring.
 */
import { ApiAuthError } from '@/lib/apiAuth.server';
import {
  billingLockoutDetail,
  getBillingSnapshot,
  isLockedOut,
  tierInsufficientDetail,
  TIER_INSUFFICIENT_CODE,
  TRIAL_EXPIRED_CODE,
  type BillingSnapshot,
  type BillingSnapshotOptions,
  type LockedBillingState,
} from '@/lib/billing/billingSnapshot.server';
import type { SiteTier } from '@/lib/siteTier';

export {
  getBillingSnapshot,
  TIER_INSUFFICIENT_CODE,
  TRIAL_EXPIRED_CODE,
  type BillingSnapshot,
  type BillingSnapshotOptions,
};

/**
 * Missing-site failure. Matches `assertUserHasSiteAccess()` exactly — same
 * status, same message, no `code` — so a gate that runs before the access
 * check is indistinguishable from one that runs after, and neither leaks
 * whether the site exists.
 */
function siteNotFound(): ApiAuthError {
  return new ApiAuthError(404, 'Site not found');
}

function billingLocked(siteId: string, state: LockedBillingState): ApiAuthError {
  return new ApiAuthError(402, billingLockoutDetail(state), {
    code: TRIAL_EXPIRED_CODE,
    details: { siteId, billingState: state },
  });
}

function tierInsufficient(snapshot: BillingSnapshot): ApiAuthError {
  return new ApiAuthError(403, tierInsufficientDetail(), {
    code: TIER_INSUFFICIENT_CODE,
    details: {
      siteId: snapshot.siteId,
      tier: 'pro',
      siteTier: snapshot.siteTier,
    },
  });
}

/**
 * Resolve a site's billing snapshot, or throw `404 Site not found`.
 *
 * The base every other gate builds on. Exposed because callers that need
 * both facts (state and tier) shouldn't pay for two reads.
 */
export async function requireBillingSnapshot(
  siteId: string,
  options: BillingSnapshotOptions = {},
): Promise<BillingSnapshot> {
  const snapshot = await getBillingSnapshot(siteId, options);
  if (!snapshot) throw siteNotFound();
  return snapshot;
}

/**
 * Throw `402 trial_expired` when the account owning `siteId` is locked out
 * (`expired` or `canceled`). `trialing` and `active` pass.
 *
 * Returns the snapshot so a caller that also needs the tier can chain
 * without a second read.
 */
export async function requireActiveBilling(
  siteId: string,
  options: BillingSnapshotOptions = {},
): Promise<BillingSnapshot> {
  const snapshot = await requireBillingSnapshot(siteId, options);
  if (isLockedOut(snapshot.billingState)) {
    throw billingLocked(snapshot.siteId, snapshot.billingState);
  }
  return snapshot;
}

/**
 * Gate a pro-only feature. Billing lockout is checked first — an expired
 * account gets the 402 it can act on, not a 403 about a tier it can't
 * change while locked out.
 *
 * `trialing` passes regardless of the site's stored tier: the trial runs at
 * the pro feature level.
 */
export async function requirePro(
  siteId: string,
  options: BillingSnapshotOptions = {},
): Promise<BillingSnapshot> {
  const snapshot = await requireActiveBilling(siteId, options);
  if (snapshot.billingState === 'trialing') return snapshot;
  if (snapshot.siteTier === 'core') throw tierInsufficient(snapshot);
  return snapshot;
}

/**
 * The site's effective tier, or `404 Site not found`.
 *
 * Reports the tier as stored — it does NOT fold the trial in. Callers that
 * want "may this request use pro features?" want `requirePro()`; this is for
 * surfaces that display or branch on the subscription tier itself.
 */
export async function siteTierOrThrow(
  siteId: string,
  options: BillingSnapshotOptions = {},
): Promise<SiteTier> {
  const snapshot = await requireBillingSnapshot(siteId, options);
  return snapshot.siteTier;
}
