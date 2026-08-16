/**
 * roost storage allowance.
 *
 * Web-side mirror of `SITE_STORAGE_BYTES` in
 * `functions/src/lib/quotaLogic.ts` — web can't import from functions/, so
 * the number exists on both sides and the two must stay in sync. Every web
 * reader of a quota doc resolves its cap through here so the API responses
 * and the server-side upload admission can't drift apart.
 *
 * A flat per-site capacity limit, not an entitlement: it bounds what one
 * site may hold in R2, and applies to every site identically.
 */
export const SITE_STORAGE_BYTES = 1024 ** 4; // 1 TiB
