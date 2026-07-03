/**
 * Shared lifecycle predicates for `agent_refresh_tokens` documents.
 *
 * A token document goes through these states:
 *   - live        — the agent's current credential (shown in the admin list)
 *   - superseded  — rotated away from (>= 2.12.0 agents); its successor is now
 *                   the live token. Readable for a 5-minute grace window
 *                   (`retiresAt`) so a client that lost the rotation response
 *                   can retry, then it is dead.
 *   - expired     — `expiresAt` in the past (rare; tokens are minted without
 *                   an expiry for long-duration installs).
 *
 * "Dead" tokens are provably unusable and safe to delete: a superseded token
 * past its grace window, or an expired token. These are what the admin
 * "prune dead tokens" action removes and what rotation garbage-collects.
 *
 * These predicates are the single source of truth shared by the list route
 * (which hides superseded/expired tokens), the revoke route (prune mode), and
 * the refresh route (rotation grandparent GC), so the definitions never drift.
 */

/**
 * Coerce a Firestore timestamp-ish value to epoch millis.
 * Accepts a Firestore Timestamp ({ toMillis() }), a number (already millis),
 * a Date, or undefined/null. Returns undefined when absent/unparseable.
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
 * True when the token has been rotated away from (a successor token exists).
 * The successor is the live credential; superseded docs are hidden from the
 * admin list regardless of whether their grace window has elapsed.
 */
export function isTokenSuperseded(data: AgentTokenLifecycleFields | undefined): boolean {
  return Boolean(data?.supersededAt || data?.supersededBy);
}

/**
 * True when the token's own expiry (if any) is strictly in the past. Tokens
 * minted without `expiresAt` never expire and are never considered expired.
 *
 * This MUST mirror the refresh route's acceptance test exactly
 * (`if (expiresAt && expiresAt < now)` at agent/auth/refresh/route.ts) so a
 * token the auth endpoint would still accept can never be classified dead and
 * pruned out from under a live agent:
 *   - strict `<` (not `<=`): a token expiring at exactly `now` is still valid,
 *   - `Boolean(expiresAt)` guard: a falsy `0` epoch is treated as absent
 *     (never-expires), matching the route's truthiness check.
 */
export function isTokenExpired(
  data: AgentTokenLifecycleFields | undefined,
  now: number,
): boolean {
  const expiresAt = tokenTimestampToMillis(data?.expiresAt);
  return Boolean(expiresAt) && (expiresAt as number) < now;
}

/**
 * True when the token is provably unusable and safe to delete:
 *   - superseded AND past its grace window (retiresAt in the past, or absent —
 *     which the refresh route already treats as expired), OR
 *   - expired.
 *
 * A superseded token still WITHIN its grace window is NOT dead — a client may
 * legitimately still be retrying with it — so it is preserved by prune/GC.
 * This mirrors the acceptance check in the refresh route exactly.
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
 * True when the token should appear in the admin "live tokens" list:
 * not superseded and not expired. (A brief in-grace superseded token is
 * hidden because its successor is already the live row.)
 */
export function isTokenLive(
  data: AgentTokenLifecycleFields | undefined,
  now: number,
): boolean {
  return !isTokenSuperseded(data) && !isTokenExpired(data, now);
}
