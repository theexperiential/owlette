/**
 * security config reader (security-boundary-migration wave 2.1).
 *
 * Reads the global kill-switch state for the authorization stack from
 * `global/security_config` (firestore) with an in-memory ttl cache and
 * env-var fallback when firestore is unavailable.
 *
 * Two boolean flags:
 *   - `capability_enforcement` — when `false`, capability checks in
 *     `authorizedSiteHandler` / `authorizedPlatformHandler` are bypassed.
 *     Audit row carries `metadata.enforcement_bypassed: 'capability'`.
 *   - `rate_limit_enforcement` — when `false`, rate-limit checks in the
 *     same wrappers are bypassed. Audit row carries
 *     `metadata.enforcement_bypassed: 'rate_limit'`.
 *
 * The api-key scope check is NEVER bypassed by these flags — that's
 * defense against the confused-deputy bug where a downgraded key would
 * gain elevated effective rights during an enforcement outage.
 *
 * Auto-expiry: when the firestore document carries a `*_expiresAt` field
 * whose timestamp is in the past, that flag is treated as `true`
 * (re-enabled) regardless of its stored boolean. The kill-switch route
 * sets a 4h default expiry so an operator can't accidentally leave the
 * fleet unguarded indefinitely.
 *
 * Cache: 5-second module-scoped ttl. Sized to be short enough that an
 * operator flipping the switch sees fleet-wide effect within seconds,
 * but long enough that a hot endpoint isn't doing one firestore read
 * per request.
 *
 * Observability: every flip-state-change (between consecutive reads
 * that made it through the cache) emits a `logger.warn` entry. Wave 8.2
 * will replace the warn line with a real metric counter.
 */

import { Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';

/* -------------------------------------------------------------------------- */
/*  types                                                                     */
/* -------------------------------------------------------------------------- */

export interface SecurityConfig {
  capability_enforcement: boolean;
  rate_limit_enforcement: boolean;
  /** Server-time epoch ms of the last successful firestore read (or 0). */
  lastUpdated: number;
  /**
   * Server-time epoch ms when the cache entry expires. Distinct from the
   * per-flag firestore expiresAt fields — that's the auto-re-enable time
   * for the kill switch itself.
   */
  expiresAt: number;
}

interface RawSecurityConfigDoc {
  capability_enforcement?: boolean;
  rate_limit_enforcement?: boolean;
  capability_enforcement_expiresAt?: Timestamp | { toMillis?: () => number } | number | null;
  rate_limit_enforcement_expiresAt?: Timestamp | { toMillis?: () => number } | number | null;
}

/* -------------------------------------------------------------------------- */
/*  constants                                                                 */
/* -------------------------------------------------------------------------- */

export const SECURITY_CONFIG_PATH = 'global/security_config';
export const CACHE_TTL_MS = 5_000;

const SECURITY_CONFIG_COLLECTION = 'global';
const SECURITY_CONFIG_DOC = 'security_config';

/* -------------------------------------------------------------------------- */
/*  cache                                                                     */
/* -------------------------------------------------------------------------- */

interface CachedConfig {
  config: SecurityConfig;
  cachedAtMs: number;
}

let cachedConfig: CachedConfig | null = null;
let lastObservedFlags: {
  capability_enforcement: boolean;
  rate_limit_enforcement: boolean;
} | null = null;

/* -------------------------------------------------------------------------- */
/*  helpers                                                                   */
/* -------------------------------------------------------------------------- */

function envFlag(name: string): boolean {
  const v = process.env[name];
  if (v === undefined) return true; // default-on (fail-safe)
  const lowered = v.toLowerCase();
  return !(lowered === 'false' || lowered === '0' || lowered === 'no');
}

function envFallback(reason: string, err?: unknown): SecurityConfig {
  logger.error('[securityConfig] firestore read failed; falling back to env vars', {
    context: 'securityConfig',
    data: {
      reason,
      err: err instanceof Error ? err.message : err === undefined ? undefined : String(err),
    },
  });
  const now = Date.now();
  return {
    capability_enforcement: envFlag('ENABLE_CAPABILITY_ENFORCEMENT'),
    rate_limit_enforcement: envFlag('ENABLE_RATE_LIMIT_ENFORCEMENT'),
    lastUpdated: now,
    expiresAt: now + CACHE_TTL_MS,
  };
}

/**
 * Coerce one of the firestore Timestamp shapes (or epoch ms number) into an
 * epoch-ms number. Returns `null` for missing / unparseable values.
 */
function toMillis(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof (value as { toMillis?: () => number }).toMillis === 'function') {
    try {
      const ms = (value as { toMillis: () => number }).toMillis();
      return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Apply auto-expiry: if `expiresAt < now`, the flag is force-enabled. The
 * stored boolean is only honored while its expiry is still in the future.
 */
function applyExpiry(stored: boolean | undefined, expiresAt: number | null, nowMs: number): boolean {
  if (stored === undefined) return true; // missing field -> default-on
  if (expiresAt !== null && expiresAt < nowMs) return true; // expired -> re-enabled
  return stored;
}

function emitFlipMetric(prev: { capability_enforcement: boolean; rate_limit_enforcement: boolean } | null, next: SecurityConfig): void {
  if (!prev) {
    lastObservedFlags = {
      capability_enforcement: next.capability_enforcement,
      rate_limit_enforcement: next.rate_limit_enforcement,
    };
    return;
  }
  const changes: Record<string, { from: boolean; to: boolean }> = {};
  if (prev.capability_enforcement !== next.capability_enforcement) {
    changes.capability_enforcement = {
      from: prev.capability_enforcement,
      to: next.capability_enforcement,
    };
  }
  if (prev.rate_limit_enforcement !== next.rate_limit_enforcement) {
    changes.rate_limit_enforcement = {
      from: prev.rate_limit_enforcement,
      to: next.rate_limit_enforcement,
    };
  }
  if (Object.keys(changes).length > 0) {
    // wave 8.2 will replace this with a real metric counter; the warn
    // level is the right interim signal because operators want to see
    // every kill-switch flip in their primary logs.
    logger.warn('[securityConfig] enforcement flag changed', {
      context: 'securityConfig',
      data: { changes },
    });
  }
  lastObservedFlags = {
    capability_enforcement: next.capability_enforcement,
    rate_limit_enforcement: next.rate_limit_enforcement,
  };
}

/* -------------------------------------------------------------------------- */
/*  public api                                                                */
/* -------------------------------------------------------------------------- */

export const securityConfig = {
  /**
   * Read the current effective config. Cached for `CACHE_TTL_MS` per
   * process. On firestore failure, falls back to env-var booleans
   * (default-on) and caches that fallback for the same ttl so a sustained
   * outage doesn't hammer firestore.
   */
  async read(): Promise<SecurityConfig> {
    const now = Date.now();
    if (cachedConfig && cachedConfig.config.expiresAt > now) {
      return cachedConfig.config;
    }

    let next: SecurityConfig;
    try {
      const db = getAdminDb();
      const snap = await db
        .collection(SECURITY_CONFIG_COLLECTION)
        .doc(SECURITY_CONFIG_DOC)
        .get();
      const raw = snap.exists ? (snap.data() as RawSecurityConfigDoc | undefined) : undefined;

      const capExpires = raw ? toMillis(raw.capability_enforcement_expiresAt ?? null) : null;
      const rlExpires = raw ? toMillis(raw.rate_limit_enforcement_expiresAt ?? null) : null;

      next = {
        capability_enforcement: applyExpiry(raw?.capability_enforcement, capExpires, now),
        rate_limit_enforcement: applyExpiry(raw?.rate_limit_enforcement, rlExpires, now),
        lastUpdated: now,
        expiresAt: now + CACHE_TTL_MS,
      };
    } catch (err) {
      next = envFallback('exception', err);
    }

    emitFlipMetric(lastObservedFlags, next);
    cachedConfig = { config: next, cachedAtMs: now };
    return next;
  },

  /** Test-only hook to clear the in-memory cache between tests. */
  __resetCacheForTests(): void {
    cachedConfig = null;
    lastObservedFlags = null;
  },
};
