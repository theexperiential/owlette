'use client';

/**
 * useAccountTier (billing-system wave 3.2 — pro-tier gate UI).
 *
 * Client mirror of `requireProAccount()`'s tier half, for the surfaces whose
 * entitlement is account-scoped rather than site-scoped — api keys being the
 * only one today. Returns the same `SiteTier | undefined` shape as
 * `useSiteTier`, deliberately: `ProTierGate` takes one `tier` prop and does
 * not care which of the two resolved it, so an account-scoped call site and a
 * site-scoped one read identically.
 *
 * ## The rule, and why it matches the server exactly
 *
 * `@/lib/billingGate.server` decides an account's pro entitlement in two
 * steps, in this order:
 *
 *   1. `billingState === 'trialing'` → pro. The trial runs at the pro feature
 *      level, so a trialing account can never see a tier gate.
 *   2. otherwise `accountTier` — pro when **any** owned site resolves pro,
 *      else core (see `AccountBillingSnapshot.accountTier`).
 *
 * Step 1 is load-bearing here rather than redundant: an account trialing with
 * **zero** sites would fall through step 2 as `'core'`, while the server lets
 * it mint keys. Skipping the short-circuit would gate exactly the accounts the
 * trial exists to court.
 *
 * ## Lockout is not this hook's job
 *
 * `'expired'` / `'canceled'` accounts resolve through step 2 like any other
 * non-trialing account. The server answers those with `402 trial_expired`
 * before it ever reaches the tier check, and the surface that explains a
 * lockout is the trial banner (task 3.1) — not a gate whose whole message is
 * about tiers. The gate's "choose a plan" CTA happens to be the right remedy
 * either way.
 *
 * ## Undefined is "don't gate yet"
 *
 * `undefined` while the snapshot is in flight — and it stays `undefined` if
 * the request fails, since `useBillingSnapshot` leaves `snapshot` null. Both
 * render the ungated UI: flashing a gate at a paying customer over a transient
 * network blip is worse than briefly showing UI whose server calls the server
 * still enforces.
 */

import { useMemo } from 'react';
import { useBillingSnapshot } from '@/hooks/useBillingSnapshot';
import type { SiteTier } from '@/lib/siteTier';

/**
 * Resolve the calling account's pro entitlement as a tier.
 *
 * @param enabled — forwarded to `useBillingSnapshot`; the rising edge is what
 * fires the request. Pass `false` from a caller that stays mounted while its
 * gated section is hidden, so a dialog nobody opened doesn't spend the
 * snapshot route's per-site machine reads.
 * @returns `'core' | 'pro'` once the snapshot has landed, `undefined` while it
 * is resolving, disabled, or failed.
 */
export function useAccountTier(enabled: boolean = true): SiteTier | undefined {
  const { snapshot } = useBillingSnapshot(enabled);

  return useMemo<SiteTier | undefined>(() => {
    if (!snapshot) return undefined;
    if (snapshot.billingState === 'trialing') return 'pro';
    return snapshot.sites.some((site) => site.tier === 'pro') ? 'pro' : 'core';
  }, [snapshot]);
}
