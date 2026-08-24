/**
 * Lifecycle predicates for `agent_refresh_tokens` documents. States:
 *   live       — the agent's current credential (shown in the admin list)
 *   superseded — rotated away from; usable for a 5-minute grace (`retiresAt`)
 *                so a client that lost the rotation response can retry
 *   expired    — `expiresAt` in the past (rare; most tokens have no expiry)
 *
 * "Dead" = provably unusable and safe to delete (superseded past grace, or
 * expired) — what admin prune and rotation GC remove.
 *
 * Single source of truth for the list route, the revoke route (prune mode) and
 * the refresh route (grandparent GC), so the definitions cannot drift.
 */

/**
 * Firestore timestamp-ish → epoch millis. Accepts a Timestamp, number, or Date;
 * undefined when absent or unparseable.
 */
export function tokenTimestampToMillis(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? undefined : ms;
  }
  if (typeof value === 'object') {
    const maybe = value as { toMillis?: () => number };
    if (typeof maybe.toMillis === 'function') {
      const ms = maybe.toMillis();
      return typeof ms === 'number' && Number.isFinite(ms) ? ms : undefined;
    }
  }
  return undefined;
}

/** Minimal shape of the token fields these predicates read. */
export interface AgentTokenLifecycleFields {
  supersededAt?: unknown;
  supersededBy?: unknown;
  retiresAt?: unknown;
  expiresAt?: unknown;
}

/**
 * Rotated away from — a successor exists. Hidden from the admin list whether or
 * not the grace window has elapsed.
 */
export function isTokenSuperseded(data: AgentTokenLifecycleFields | undefined): boolean {
  return Boolean(data?.supersededAt || data?.supersededBy);
}

/**
 * Expiry strictly in the past; no `expiresAt` means never expires.
 *
 * MUST mirror `if (expiresAt && expiresAt < now)` in agent/auth/refresh/route.ts
 * or a token the auth endpoint still accepts gets pruned from under a live
 * agent: strict `<` (expiring exactly at `now` is valid) and the truthiness
 * guard (a `0` epoch counts as absent).
 */
export function isTokenExpired(
  data: AgentTokenLifecycleFields | undefined,
  now: number,
): boolean {
  const expiresAt = tokenTimestampToMillis(data?.expiresAt);
  return Boolean(expiresAt) && (expiresAt as number) < now;
}

/**
 * Provably unusable and safe to delete: expired, or superseded past its grace
 * (absent `retiresAt` counts as past, matching the refresh route). A superseded
 * token still WITHIN grace is NOT dead — a client may still be retrying it.
 */
export function isTokenDead(
  data: AgentTokenLifecycleFields | undefined,
  now: number,
): boolean {
  if (isTokenExpired(data, now)) return true;
  if (isTokenSuperseded(data)) {
    const retiresAt = tokenTimestampToMillis(data?.retiresAt);
    return retiresAt === undefined || now >= retiresAt;
  }
  return false;
}

/**
 * Belongs in the admin "live tokens" list. An in-grace superseded token is
 * hidden because its successor is already the live row.
 */
export function isTokenLive(
  data: AgentTokenLifecycleFields | undefined,
  now: number,
): boolean {
  return !isTokenSuperseded(data) && !isTokenExpired(data, now);
}
