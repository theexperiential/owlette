/**
 * Site tier helpers (api-sprint wave 3.2 — pro pricing tier substrate).
 *
 * Owns the canonical `'core' | 'pro'` tier identifier used to gate roost
 * (and any future pro-only feature) on the site doc. Kept tiny and
 * dependency-free so it can be imported from both client hooks and server
 * actions without dragging Firestore wiring into either.
 *
 * Beta posture: every site doc that predates the `tier` field behaves like
 * `'pro'`. `BETA_DEFAULT_TIER` is the read-path fallback that makes that
 * true — see the constant's own note for what it is and is no longer.
 */
export type SiteTier = 'core' | 'pro';

/**
 * Fallback tier for a site doc with no explicit `tier` field.
 *
 * **Read path only.** This is no longer the write-path default: since
 * billing-system wave 0.3, `createSite.server.ts` derives a new site's tier
 * from the owner's billing state (`customers/{uid}`) and always writes it
 * explicitly. The only sites this constant still answers for are the ones
 * minted before that field existed.
 *
 * Deleted at go-live (billing-system task 5.3), together with the
 * `getSiteTier()` fallback below, once that task has stamped an explicit
 * `tier` on every remaining unstamped site doc. Do not flip it to `'core'`
 * as a way of enabling gating — that would retroactively downgrade every
 * legacy site instead of gating new ones.
 *
 * `functions/src/lib/quotaLogic.ts` carries a mirror of this constant (web
 * can't import from functions/); the two must stay in sync until both are
 * deleted.
 */
export const BETA_DEFAULT_TIER: SiteTier = 'pro';

/**
 * Included roost storage per site, in bytes.
 *
 * Web-side mirror of `TIER_STORAGE_BYTES` in
 * `functions/src/lib/quotaLogic.ts` — web can't import from functions/, so
 * the numbers exist on both sides and must stay in sync. Every web reader of
 * a quota doc resolves its cap through here so the API responses and the
 * server-side upload admission can't drift apart again (that drift is what
 * billing-system task 0.7 exists to fix).
 *
 * `core` is `0` rather than a small allowance: roost is a pro-tier feature,
 * so a core site has no storage entitlement at all. Callers surface that to
 * clients as `roostAvailable: false`, not as a zero-byte quota.
 */
export const TIER_STORAGE_BYTES: Record<SiteTier, number> = {
  core: 0,
  pro: 1024 ** 4, // 1 TiB
};

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
 *
 * Read-path helper only: code that *writes* a tier must derive it from the
 * account's billing state (see `createSite.server.ts`), never from here.
 */
export function getSiteTier(site: SiteTierSource | null | undefined): SiteTier {
  const raw = site?.tier;
  if (raw === 'core') return 'core';
  if (raw === 'pro') return 'pro';
  return BETA_DEFAULT_TIER;
}
