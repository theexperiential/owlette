/**
 * Site tier helpers (api-sprint wave 3.2 — pro pricing tier substrate).
 *
 * Owns the canonical `'core' | 'pro'` tier identifier used to gate roost
 * (and any future pro-only feature) on the site doc. Kept tiny and
 * dependency-free so it can be imported from both client hooks and server
 * actions without dragging Firestore wiring into either.
 *
 * Beta posture: every site behaves like `'pro'` until billing wiring lands
 * in a separate sprint. `BETA_DEFAULT_TIER` is the single switch that flips
 * once the beta exits — UI gates and the createSite default both read from
 * here, so flipping it to `'core'` simultaneously enables the gate and stops
 * minting new pro sites for free.
 */
export type SiteTier = 'core' | 'pro';

/**
 * Default tier applied during the public beta. Every site without an
 * explicit `tier` field is treated as this value, and every newly-created
 * site is written with it. Flip to `'core'` (in this one place) when the
 * pro tier starts being a paid distinction.
 */
export const BETA_DEFAULT_TIER: SiteTier = 'pro';

/**
 * Narrow Site shape — accepts anything with an optional `tier` so this
 * helper can be used against the dashboard `Site` type, raw Firestore
 * data, or admin-side payloads without forcing a circular import.
 */
interface SiteTierSource {
  tier?: SiteTier | string | null;
}

/**
 * Resolve a site's effective tier.
 *
 * - `tier === 'core'` → `'core'`
 * - `tier === 'pro'`  → `'pro'`
 * - anything else (undefined, null, unknown string) → `BETA_DEFAULT_TIER`
 *
 * Centralising the undefined → default fallback here is the whole reason
 * this module exists. Callers must never special-case `tier === undefined`
 * inline — that would scatter the beta-exit migration across the codebase.
 */
export function getSiteTier(site: SiteTierSource | null | undefined): SiteTier {
  const raw = site?.tier;
  if (raw === 'core') return 'core';
  if (raw === 'pro') return 'pro';
  return BETA_DEFAULT_TIER;
}
