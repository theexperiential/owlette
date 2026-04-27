/**
 * rate limit helper (security-boundary-migration wave 1.4).
 *
 * Two-layer per-capability rate limiter with separate buckets for user and
 * system actors. The two buckets are completely isolated — system traffic
 * cannot consume user-bucket tokens and vice versa — so cortex bursts and
 * scheduled-job traffic don't squeeze human operators out of their quota.
 *
 *   layer 1 — in-memory token bucket (best-effort optimization only)
 *   --------------------------------------------------------------
 *   Per-process Map keyed by `${actor.type}:${actorId}:${capability}`. We
 *   refill tokens at `limit / 60s` and reject when the bucket is empty.
 *   This layer absorbs the trivial bursts of one client hammering one
 *   replica, so we don't pay a firestore round-trip for every call. It is
 *   NOT authoritative — railway runs multiple replicas and each replica
 *   has its own Map. A determined caller can pass this layer N times in
 *   parallel (one per replica). Treat it as cache, not enforcement.
 *
 *   layer 2 — firestore sharded counter (authoritative)
 *   ---------------------------------------------------
 *   10-shard fixed-window counter at
 *     `sites/{siteId}/rate_limits/{bucket}/{capability}/shards/{0..9}`
 *   where `bucket` is `'user'` or `'system'`. Each request increments one
 *   randomly-selected shard inside a transaction; the limit check sums all
 *   10 shards. Using shards instead of a single counter avoids the 1
 *   write/sec/document firestore contention ceiling — 10 shards lift the
 *   ceiling to ~10 writes/sec/(siteId × capability × bucket), which is
 *   well above any expected legitimate workload. Window state
 *   (`{ count, windowStart }`) is rolled forward on the first write into a
 *   new window; stale shards are reset transactionally on read-modify-write
 *   so the limiter is self-healing if a shard is touched after the window
 *   it was last incremented in has elapsed.
 *
 * The combined entry point is `checkRateLimit(actor, capability, siteId)`,
 * which fails fast on the in-memory layer (so a hot loop on one replica
 * never hits firestore) and otherwise consults the appropriate bucket in
 * firestore. A rejection always returns `{ ok: false, reason: 'rate_limited',
 * retryAfterSec }`; a pass returns `{ ok: true }`.
 */

import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';
import {
  type Actor,
  type Capability,
  Capability as CapabilityEnum,
} from '@/lib/capabilities';
import { FieldValue } from 'firebase-admin/firestore';

/* -------------------------------------------------------------------------- */
/*  default per-minute limits                                                 */
/* -------------------------------------------------------------------------- */

export interface CapabilityLimit {
  /** Tokens granted per 60-second window. */
  perMinute: number;
}

/**
 * Default user-bucket limits. These are the per-actor ceilings for human
 * operators (sessions + api keys) and are deliberately tight enough to
 * blunt a misconfigured CI loop while staying well above the
 * fastest-fingered human dashboard user. Calibrated in wave 8.0 against
 * shadow data; current numbers are reasonable starting points.
 */
export const USER_LIMITS: Readonly<Record<Capability, CapabilityLimit>> = {
  [CapabilityEnum.MACHINE_EXEC_COMMAND]: { perMinute: 60 },
  [CapabilityEnum.MACHINE_CONFIG_WRITE]: { perMinute: 30 },
  [CapabilityEnum.MACHINE_REMOVE]: { perMinute: 5 },
  [CapabilityEnum.DEPLOYMENT_MANAGE]: { perMinute: 30 },
  [CapabilityEnum.DISTRIBUTION_MANAGE]: { perMinute: 30 },
  [CapabilityEnum.UNINSTALL_TRIGGER]: { perMinute: 30 },
  [CapabilityEnum.PRESET_MANAGE]: { perMinute: 60 },
  [CapabilityEnum.SITE_MEMBER_MANAGE]: { perMinute: 30 },
  [CapabilityEnum.WEBHOOK_MANAGE]: { perMinute: 30 },
  [CapabilityEnum.USER_ROLE_MANAGE]: { perMinute: 10 },
  [CapabilityEnum.USER_DELETE]: { perMinute: 5 },
  [CapabilityEnum.SYSTEM_PRESET_MANAGE]: { perMinute: 30 },
  [CapabilityEnum.INSTALLER_MANAGE]: { perMinute: 10 },
  [CapabilityEnum.GLOBAL_SETTINGS_WRITE]: { perMinute: 10 },
  [CapabilityEnum.USER_SELF_PREFS]: { perMinute: 120 },
  [CapabilityEnum.USER_SELF_DELETE]: { perMinute: 1 },
};

/**
 * Default system-bucket limits — 5x user. Cortex autonomous mode produces
 * legitimate burst traffic when reconciling many machines (e.g. reacting
 * to a fleet-wide drift event), and scheduled-cleanup jobs sweep large
 * windows in tight loops. Both need headroom user traffic doesn't.
 */
export const SYSTEM_LIMITS: Readonly<Record<Capability, CapabilityLimit>> = {
  [CapabilityEnum.MACHINE_EXEC_COMMAND]: { perMinute: 300 },
  [CapabilityEnum.MACHINE_CONFIG_WRITE]: { perMinute: 150 },
  [CapabilityEnum.MACHINE_REMOVE]: { perMinute: 25 },
  [CapabilityEnum.DEPLOYMENT_MANAGE]: { perMinute: 150 },
  [CapabilityEnum.DISTRIBUTION_MANAGE]: { perMinute: 150 },
  [CapabilityEnum.UNINSTALL_TRIGGER]: { perMinute: 150 },
  [CapabilityEnum.PRESET_MANAGE]: { perMinute: 300 },
  [CapabilityEnum.SITE_MEMBER_MANAGE]: { perMinute: 150 },
  [CapabilityEnum.WEBHOOK_MANAGE]: { perMinute: 150 },
  [CapabilityEnum.USER_ROLE_MANAGE]: { perMinute: 50 },
  [CapabilityEnum.USER_DELETE]: { perMinute: 25 },
  [CapabilityEnum.SYSTEM_PRESET_MANAGE]: { perMinute: 150 },
  [CapabilityEnum.INSTALLER_MANAGE]: { perMinute: 50 },
  [CapabilityEnum.GLOBAL_SETTINGS_WRITE]: { perMinute: 50 },
  [CapabilityEnum.USER_SELF_PREFS]: { perMinute: 600 },
  [CapabilityEnum.USER_SELF_DELETE]: { perMinute: 5 },
};

/* -------------------------------------------------------------------------- */
/*  shared types                                                              */
/* -------------------------------------------------------------------------- */

export type Bucket = 'user' | 'system';
export const SHARD_COUNT = 10;
export const WINDOW_SEC = 60;

export type RateLimitResult =
  | { ok: true }
  | { ok: false; reason: 'rate_limited'; retryAfterSec: number };

type RateLimitObservationSource = 'in_memory' | 'firestore';

/**
 * Resolve which bucket an actor lives in. User sessions and api keys both
 * map to `'user'`; cortex / scheduled jobs map to `'system'`.
 */
export function bucketForActor(actor: Actor): Bucket {
  return actor.type === 'system' ? 'system' : 'user';
}

/**
 * Stable identifier for an actor inside its bucket. Distinct user ids and
 * distinct system actor names get distinct in-memory keys.
 */
export function actorIdentifier(actor: Actor): string {
  return actor.type === 'system' ? actor.name : actor.userId;
}

/* -------------------------------------------------------------------------- */
/*  layer 1 — in-memory token bucket (best-effort)                            */
/* -------------------------------------------------------------------------- */

interface TokenBucket {
  tokens: number;
  lastRefillMs: number;
}

/**
 * Per-process token-bucket map. SEPARATE buckets for `'user'` and
 * `'system'` are guaranteed by including `actor.type` in the key prefix;
 * the same userId could (in principle) collide with the same system-actor
 * name, but the type prefix makes those keys disjoint.
 *
 * NOT shared across replicas — railway spins up N processes and each has
 * its own Map. Use `__resetInMemoryBucketsForTests()` in tests; in
 * production the only persistence is the Map's own lifecycle.
 */
const inMemoryBuckets = new Map<string, TokenBucket>();

function inMemoryKey(actor: Actor, capability: Capability): string {
  return `${actor.type}:${actorIdentifier(actor)}:${capability}`;
}

/**
 * Best-effort in-memory token bucket. Consumes one token if available and
 * returns `true`; returns `false` when empty. Refill rate = `perMinute /
 * 60` tokens per second. Bucket capacity = `perMinute` (a fresh actor
 * starts with a full bucket so legitimate burst usage is allowed).
 *
 * Documented elsewhere as best-effort: a single replica enforces this
 * limit, but multi-replica deployments will let approximately
 * `replicas × perMinute` requests through before the firestore layer
 * catches up.
 */
export function checkInMemoryBurst(
  actor: Actor,
  capability: Capability
): boolean {
  const limits = bucketForActor(actor) === 'system' ? SYSTEM_LIMITS : USER_LIMITS;
  const limit = limits[capability];
  if (!limit) return true; // no limit configured -> allow
  const capacity = limit.perMinute;
  const refillPerMs = capacity / (WINDOW_SEC * 1000);

  const key = inMemoryKey(actor, capability);
  const now = Date.now();
  const existing = inMemoryBuckets.get(key);

  if (!existing) {
    // Fresh actor: full bucket, consume one.
    inMemoryBuckets.set(key, { tokens: capacity - 1, lastRefillMs: now });
    return true;
  }

  const elapsedMs = Math.max(0, now - existing.lastRefillMs);
  const refilled = Math.min(capacity, existing.tokens + elapsedMs * refillPerMs);

  if (refilled < 1) {
    existing.tokens = refilled;
    existing.lastRefillMs = now;
    return false;
  }

  existing.tokens = refilled - 1;
  existing.lastRefillMs = now;
  return true;
}

/** Test-only hook: clears the in-memory bucket map between tests. */
export function __resetInMemoryBucketsForTests(): void {
  inMemoryBuckets.clear();
}

function isObserveOnly(): boolean {
  return process.env.RATE_LIMIT_OBSERVE_ONLY === 'true';
}

async function recordRateLimitObservation(params: {
  actor: Actor;
  bucket: Bucket;
  capability: Capability;
  configuredLimitPerMinute: number;
  siteId: string;
  source: RateLimitObservationSource;
  retryAfterSec: number;
}): Promise<void> {
  try {
    await getAdminDb().collection('rate_limit_observations').add({
      schemaVersion: 1,
      siteId: params.siteId,
      bucket: params.bucket,
      capability: params.capability,
      actorType: params.actor.type,
      actorId: actorIdentifier(params.actor),
      source: params.source,
      configuredLimitPerMinute: params.configuredLimitPerMinute,
      windowSec: WINDOW_SEC,
      retryAfterSec: params.retryAfterSec,
      observedMinuteMs: Math.floor(Date.now() / 60000) * 60000,
      observedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    logger.warn('[rateLimit] observe-only write failed; allowing request', {
      context: 'rateLimit',
      data: {
        err: err instanceof Error ? err.message : String(err),
        siteId: params.siteId,
        bucket: params.bucket,
        capability: params.capability,
      },
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  layer 2 — firestore sharded counter (authoritative)                       */
/* -------------------------------------------------------------------------- */

interface ShardDoc {
  count: number;
  windowStart: number; // epoch seconds
}

/**
 * Pick a random shard index. Module-scoped indirection so tests can stub
 * shard selection deterministically.
 */
export function pickShardIndex(): number {
  return Math.floor(Math.random() * SHARD_COUNT);
}

function shardsCollection(siteId: string, bucket: Bucket, capability: Capability) {
  return getAdminDb()
    .collection('sites')
    .doc(siteId)
    .collection('rate_limits')
    .doc(bucket)
    .collection(capability)
    .doc('shards')
    .collection('shards');
}

/**
 * Increment one random shard and verify the (siteId, bucket, capability)
 * total stays within `limit` for the active 60-second window.
 *
 * Returns `{ ok: true }` if the post-increment total is `<= limit`.
 * Returns `{ ok: false, reason: 'rate_limited', retryAfterSec }` if the
 * limit was already at/over before this call (we still write the
 * increment so the counter reflects attempted load — this is consistent
 * with a fixed-window counter and means observability sees the pressure).
 *
 * `retryAfterSec` is the time remaining in the current window, clamped to
 * [1, WINDOW_SEC].
 *
 * Authoritative: this layer is the source of truth. Any caller bypassing
 * it (e.g. the in-memory layer being the only check) is documented as
 * best-effort, not enforcement.
 */
export async function checkFirestoreLimit(
  siteId: string,
  bucket: Bucket,
  capability: Capability,
  limit: number,
  windowSec: number = WINDOW_SEC
): Promise<RateLimitResult> {
  if (limit <= 0) {
    return {
      ok: false,
      reason: 'rate_limited',
      retryAfterSec: windowSec,
    };
  }

  const db = getAdminDb();
  const shardIndex = pickShardIndex();
  const col = shardsCollection(siteId, bucket, capability);
  const targetRef = col.doc(String(shardIndex));
  const nowSec = Math.floor(Date.now() / 1000);

  // 1. Increment the chosen shard transactionally, rolling the window
  //    forward if this shard's stored windowStart is stale.
  let chosenWindowStart = nowSec;
  try {
    chosenWindowStart = await db.runTransaction(async (tx) => {
      const snap = await tx.get(targetRef);
      const data = snap.exists ? (snap.data() as ShardDoc | undefined) : undefined;
      const prevStart = data?.windowStart ?? 0;
      const inWindow = data && nowSec - prevStart < windowSec;
      const nextStart = inWindow ? prevStart : nowSec;
      const nextCount = inWindow ? (data?.count ?? 0) + 1 : 1;
      tx.set(targetRef, { count: nextCount, windowStart: nextStart });
      return nextStart;
    });
  } catch (err) {
    // Authoritative layer failed. Fail-closed would penalize legitimate
    // traffic during a firestore outage; fail-open would let abuse
    // through. We log loudly and fail-open — in-memory layer still
    // applies, and the 5s securityConfig kill-switch (wave 2.1) is the
    // operator's escape hatch. Surface the error so observability sees
    // it.
    logger.error('[rateLimit] firestore increment failed; failing open', {
      context: 'rateLimit',
      data: {
        err: err instanceof Error ? err.message : String(err),
        siteId,
        bucket,
        capability,
      },
    });
    return { ok: true };
  }

  // 2. Read all 10 shards and sum counts that belong to the window we
  //    just incremented into. Stale shards (windowStart < chosenStart)
  //    are silently ignored — they'll be reset on their next write.
  let total = 0;
  try {
    const snapshot = await col.get();
    snapshot.forEach((doc) => {
      const data = doc.data() as ShardDoc | undefined;
      if (!data) return;
      if (data.windowStart === chosenWindowStart) {
        total += data.count ?? 0;
      } else if (data.windowStart > chosenWindowStart) {
        // A racing increment landed in a newer window after our write.
        // Count it — anything that belongs to a window ≥ ours is live.
        total += data.count ?? 0;
      }
    });
  } catch (err) {
    logger.error('[rateLimit] firestore shard sum failed; failing open', {
      context: 'rateLimit',
      data: {
        err: err instanceof Error ? err.message : String(err),
        siteId,
        bucket,
        capability,
      },
    });
    return { ok: true };
  }

  if (total > limit) {
    const elapsed = nowSec - chosenWindowStart;
    const retryAfterSec = Math.max(1, Math.min(windowSec, windowSec - elapsed));
    return { ok: false, reason: 'rate_limited', retryAfterSec };
  }

  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/*  combined entry point                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Check the rate limit for `actor` on `capability` (scoped to `siteId`
 * for the firestore layer). Routes the actor to its appropriate bucket
 * (`'user'` or `'system'`); separate buckets are keyed at distinct
 * firestore paths and in distinct in-memory map slots, so a system actor
 * cannot consume a user-bucket token and vice versa.
 *
 * Order of operations:
 *   1. Resolve bucket + per-minute limit from `USER_LIMITS` /
 *      `SYSTEM_LIMITS`. Capabilities not present in the relevant map are
 *      allowed (treated as "no limit configured").
 *   2. Best-effort in-memory burst check. If empty, reject without ever
 *      hitting firestore — this keeps a runaway loop on one replica from
 *      inflating the firestore counter.
 *   3. Authoritative firestore sharded counter check.
 *
 * Returns `{ ok: true }` on pass, `{ ok: false, reason: 'rate_limited',
 * retryAfterSec }` on reject. `retryAfterSec` is the window remainder
 * for firestore-layer rejections; for in-memory rejections it is
 * `WINDOW_SEC` (we don't track per-bucket refill time precisely enough
 * to give a tighter answer).
 */
export async function checkRateLimit(
  actor: Actor,
  capability: Capability,
  siteId: string
): Promise<RateLimitResult> {
  // E2E runs exercise many capability-protected routes back-to-back through
  // one browser actor. Keep production enforcement on by default, but honor
  // the explicit Playwright env override used by the older API limiter.
  if (process.env.E2E_DISABLE_RATE_LIMIT === 'true') {
    return { ok: true };
  }

  const bucket = bucketForActor(actor);
  const limits = bucket === 'system' ? SYSTEM_LIMITS : USER_LIMITS;
  const limit = limits[capability];
  if (!limit) {
    // No limit configured for this capability/bucket pair — allow.
    return { ok: true };
  }

  const observeOnly = isObserveOnly();

  if (!checkInMemoryBurst(actor, capability)) {
    const result: RateLimitResult = {
      ok: false,
      reason: 'rate_limited',
      retryAfterSec: WINDOW_SEC,
    };
    if (observeOnly) {
      await recordRateLimitObservation({
        actor,
        bucket,
        capability,
        configuredLimitPerMinute: limit.perMinute,
        siteId,
        source: 'in_memory',
        retryAfterSec: result.retryAfterSec,
      });
      return { ok: true };
    }
    return result;
  }

  const result = await checkFirestoreLimit(siteId, bucket, capability, limit.perMinute);
  if (!result.ok && observeOnly) {
    await recordRateLimitObservation({
      actor,
      bucket,
      capability,
      configuredLimitPerMinute: limit.perMinute,
      siteId,
      source: 'firestore',
      retryAfterSec: result.retryAfterSec,
    });
    return { ok: true };
  }

  return result;
}
