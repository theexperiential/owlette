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
 * **Where the gates are called.** Wave 0.5 wired the public-API lockout (see
 * `requireApiKeyBilling` in `@/lib/apiAuth.server`). Wave 0.6 adds the two
 * remaining surfaces:
 *
 *   - pro-only public-API routes, via `{ requirePro: true }` at their scope
 *     resolution in `@/app/api/_shared` (plus `requireProAccount()` for
 *     api-key creation, which is account-scoped rather than site-scoped);
 *   - the control-plane lockout, wired centrally in
 *     `authorizedSiteHandler` — see `BILLING_LOCKED_CAPABILITIES` below.
 */
import { NextResponse } from 'next/server';
import { ApiAuthError } from '@/lib/apiAuth.server';
import { problemTierInsufficient, problemTrialExpired } from '@/lib/apiErrors';
import {
  billingLockoutDetail,
  billingWarningFor,
  getAccountBillingSnapshot,
  getBillingSnapshot,
  isLockedOut,
  tierInsufficientDetail,
  BILLING_WARNING_HEADER,
  TIER_INSUFFICIENT_CODE,
  TRIAL_EXPIRED_CODE,
  type AccountBillingSnapshot,
  type BillingSnapshot,
  type BillingSnapshotOptions,
  type LockedBillingState,
} from '@/lib/billing/billingSnapshot.server';
import { Capability } from '@/lib/capabilities';
import type { SiteTier } from '@/lib/siteTier';

export {
  billingWarningFor,
  getAccountBillingSnapshot,
  getBillingSnapshot,
  BILLING_WARNING_HEADER,
  TIER_INSUFFICIENT_CODE,
  TRIAL_EXPIRED_CODE,
  type AccountBillingSnapshot,
  type BillingSnapshot,
  type BillingSnapshotOptions,
};

/**
 * Capabilities the trial/subscription lockout blocks (billing-system wave
 * 0.6). `authorizedSiteHandler` consults this set on every **mutating**
 * request — a `GET` carrying one of these capabilities is a read and is
 * never gated (`/deployments` and `/project-distributions` list under
 * `DEPLOYMENT_MANAGE` / `DISTRIBUTION_MANAGE`, so the capability alone can
 * not stand in for "this is a mutation").
 *
 * The membership follows plan.md's lockout matrix — "process control,
 * deploy, restart, display config" and "roost uploads / deploys" blocked;
 * everything else still reachable:
 *
 *   - `MACHINE_EXEC_COMMAND` — reboot, process start/stop/restart/kill,
 *     display topology. `MACHINE_VIEW` is deliberately absent: screenshot
 *     and live-view commands are *viewing*, which the matrix keeps open
 *     (`commands/route.ts` splits its POST across both capabilities, so this
 *     set is what draws the line between them).
 *   - `MACHINE_CONFIG_WRITE` — display layout, reboot schedule, process
 *     config, cortex settings.
 *   - `DEPLOYMENT_MANAGE` — deploy, retry, cancel, uninstall-by-deployment.
 *   - `DISTRIBUTION_MANAGE` — project distribution create / cancel / delete.
 *
 * Deliberately **not** locked, and why — each of these is either the
 * customer's way out of the lockout or a safety valve that must not depend
 * on a paid subscription:
 *
 *   - `MACHINE_REMOVE`, `UNINSTALL_TRIGGER` — decommissioning machines is
 *     how a customer *reduces* their bill; trapping them is punitive.
 *   - `SITE_MEMBER_MANAGE` — revoking a member's access is a security
 *     action (it also covers site rename/delete).
 *   - `GLOBAL_SETTINGS_WRITE` — carries agent-token revocation, likewise
 *     security.
 *   - `PRESET_MANAGE`, `SITE_LOGS_MANAGE` — edit stored config/records;
 *     neither reaches a machine.
 */
export const BILLING_LOCKED_CAPABILITIES: ReadonlySet<Capability> =
  new Set<Capability>([
    Capability.MACHINE_EXEC_COMMAND,
    Capability.MACHINE_CONFIG_WRITE,
    Capability.DEPLOYMENT_MANAGE,
    Capability.DISTRIBUTION_MANAGE,
  ]);

/** True when this capability is subject to the control-plane lockout. */
export function isBillingLockedCapability(capability: Capability): boolean {
  return BILLING_LOCKED_CAPABILITIES.has(capability);
}

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

/* -------------------------------------------------------------------------- */
/*  account-scoped gates                                                      */
/* -------------------------------------------------------------------------- */

function accountBillingLocked(state: LockedBillingState): ApiAuthError {
  return new ApiAuthError(402, billingLockoutDetail(state), {
    code: TRIAL_EXPIRED_CODE,
    details: { billingState: state },
  });
}

function accountTierInsufficient(snapshot: AccountBillingSnapshot): ApiAuthError {
  // No `siteId` in the details: the failure is about the account, not one
  // site, and naming an arbitrary one would send the caller to the wrong
  // upgrade target. `billingErrorToProblem()` omits the `required` block
  // rather than inventing an id.
  return new ApiAuthError(403, tierInsufficientDetail(), {
    code: TIER_INSUFFICIENT_CODE,
    details: { tier: 'pro', accountTier: snapshot.accountTier },
  });
}

/**
 * Account-level counterpart to {@link requireActiveBilling}: throws `402
 * trial_expired` when the account itself is locked out.
 *
 * For gates with no site in hand — api-key creation is the only one today.
 * Everything site-scoped should keep using {@link requireActiveBilling},
 * which is one read cheaper and reports the site in its error details.
 */
export async function requireActiveAccountBilling(
  uid: string,
  options: BillingSnapshotOptions = {},
): Promise<AccountBillingSnapshot> {
  const snapshot = await getAccountBillingSnapshot(uid, options);
  if (isLockedOut(snapshot.billingState)) {
    throw accountBillingLocked(snapshot.billingState);
  }
  return snapshot;
}

/**
 * Account-level counterpart to {@link requirePro}. Same precedence — lockout
 * first, then tier — and the same trial carve-out: `'trialing'` passes, so
 * during the trial every account can mint api keys.
 *
 * The account counts as pro when **any** site it owns resolves pro; see
 * `AccountBillingSnapshot.accountTier` for why that is the right reading.
 */
export async function requireProAccount(
  uid: string,
  options: BillingSnapshotOptions = {},
): Promise<AccountBillingSnapshot> {
  const snapshot = await requireActiveAccountBilling(uid, options);
  if (snapshot.billingState === 'trialing') return snapshot;
  if (snapshot.accountTier === 'core') throw accountTierInsufficient(snapshot);
  return snapshot;
}

/* -------------------------------------------------------------------------- */
/*  error rendering                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Render a billing `ApiAuthError` as its RFC 7807 response, or `null` when
 * the error is not a billing failure (so the caller can go on handling it).
 *
 * One converter for all three call sites — `requireBillingOrProblem()` in
 * `@/app/api/_shared`, `authErrorToResponse()` in
 * `@/lib/authorizedHandler.server`, and the api-key creation route — so the
 * wire shape of a 402/403 can't drift between the public API and the
 * control plane.
 *
 * `fallbackSiteId` only fills in a site-scoped failure whose details somehow
 * arrived without one. An account-scoped failure has no site by design: with
 * no id from either source the `required` block is omitted entirely rather
 * than reported as `'unknown'`.
 */
export function billingErrorToProblem(
  err: unknown,
  fallbackSiteId?: string,
): NextResponse | null {
  if (!(err instanceof ApiAuthError)) return null;

  if (err.code === TRIAL_EXPIRED_CODE) {
    const state =
      typeof err.details?.billingState === 'string' ? err.details.billingState : undefined;
    return problemTrialExpired(err.message, state);
  }

  if (err.code === TIER_INSUFFICIENT_CODE) {
    const d = err.details as
      | { siteId?: string; tier?: string; siteTier?: string }
      | undefined;
    const siteId = typeof d?.siteId === 'string' ? d.siteId : fallbackSiteId;
    if (!siteId) return problemTierInsufficient(err.message);
    return problemTierInsufficient(err.message, {
      siteId,
      tier: d?.tier ?? 'pro',
      siteTier: d?.siteTier ?? 'unknown',
    });
  }

  return null;
}
