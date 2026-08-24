/**
 * Reads the authorization stack's kill switches from `global/security_config`
 * with a 5s module-scoped cache (fast enough that a flip lands fleet-wide in
 * seconds, slow enough that hot endpoints don't read per request) and an env-var
 * fallback when firestore is down.
 *
 * `capability_enforcement` / `rate_limit_enforcement` = false bypasses that
 * check in `authorizedSiteHandler` / `authorizedPlatformHandler` and stamps
 * `metadata.enforcement_bypassed` on the audit row.
 *
 * The api-key scope check is NEVER bypassed — otherwise a downgraded key would
 * gain elevated effective rights during an enforcement outage.
 *
 * Auto-expiry: a `*_expiresAt` in the past forces that flag back to `true`
 * regardless of the stored boolean (kill-switch route defaults to 4h), so the
 * fleet can't be left unguarded indefinitely.
 */

import { Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';
import { emitSecurityBoundaryMetric } from '@/lib/securityBoundaryMetrics.server';

// types

export interface SecurityConfig {
  capability_enforcement: boolean;
  rate_limit_enforcement: boolean;
  /** Server-time epoch ms of the last successful firestore read (or 0). */
  lastUpdated: number;
  /** Cache-entry expiry (epoch ms) — not the per-flag firestore expiresAt, which
   *  is the kill switch's auto-re-enable time. */
  expiresAt: number;
}

interface RawSecurityConfigDoc {
  capability_enforcement?: boolean;
  rate_limit_enforcement?: boolean;
  capability_enforcement_expiresAt?: Timestamp | { toMillis?: () => number } | number | null;
  rate_limit_enforcement_expiresAt?: Timestamp | { toMillis?: () => number } | number | null;
}

// constants

export const SECURITY_CONFIG_PATH = 'global/security_config';
export const CACHE_TTL_MS = 5_000;

const SECURITY_CONFIG_COLLECTION = 'global';
const SECURITY_CONFIG_DOC = 'security_config';

// cache

interface CachedConfig {
  config: SecurityConfig;
  cachedAtMs: number;
}

let cachedConfig: CachedConfig | null = null;
let lastObservedFlags: {
  capability_enforcement: boolean;
  rate_limit_enforcement: boolean;
} | null = null;

// helpers

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

/** Any firestore Timestamp shape (or epoch ms) → epoch ms; `null` if unparseable. */
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
  const capabilityChanged = prev ? prev.capability_enforcement !== next.capability_enforcement : false;
  const rateLimitChanged = prev ? prev.rate_limit_enforcement !== next.rate_limit_enforcement : false;

  emitSecurityBoundaryMetric('kill_switch_state', next.capability_enforcement ? 1 : 0, {
    severity: capabilityChanged ? 'warning' : 'info',
    labels: {
      flag: 'capability_enforcement',
      enabled: next.capability_enforcement,
      changed: capabilityChanged,
    },
    fields: {
      lastUpdated: next.lastUpdated,
      expiresAt: next.expiresAt,
    },
  });
  emitSecurityBoundaryMetric('kill_switch_state', next.rate_limit_enforcement ? 1 : 0, {
    severity: rateLimitChanged ? 'warning' : 'info',
    labels: {
      flag: 'rate_limit_enforcement',
      enabled: next.rate_limit_enforcement,
      changed: rateLimitChanged,
    },
    fields: {
      lastUpdated: next.lastUpdated,
      expiresAt: next.expiresAt,
    },
  });

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
    // warn level on purpose: operators want every kill-switch flip in their
    // primary logs (a metric counter is the eventual replacement).
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

// public api

export const securityConfig = {
  /**
   * Effective config, cached for `CACHE_TTL_MS` per process. On firestore failure
   * falls back to env-var booleans (default-on) and caches that too, so a
   * sustained outage doesn't hammer firestore.
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
