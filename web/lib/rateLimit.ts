/**
 * Rate Limiting Utilities
 *
 * Uses Upstash Redis for distributed rate limiting across serverless deployments.
 * Supports multiple rate limiting strategies:
 * - Sliding window: Smooths out traffic spikes
 * - Fixed window: Simple time-based limits
 * - Token bucket: Burst-tolerant rate limiting
 *
 * FREE TIER: Upstash provides 10,000 requests/day free
 */

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { NextRequest } from 'next/server';

// Initialize Redis client
// Gracefully handle missing credentials (allows local dev without Redis)
let redis: Redis | null = null;

if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  console.log('[RateLimit] Upstash Redis initialized');
} else {
  console.warn(
    '[RateLimit] Upstash Redis not configured. Rate limiting disabled. ' +
    'Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to enable.'
  );
}

// Environment detection for dev-aware rate limits
const isDevEnv = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.includes('-dev');

// Rate limiting strategies for different endpoints

/**
 * Sliding window rate limiter for general auth endpoints
 * Allows 10 requests per minute per IP
 */
export const authRateLimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(10, '1 m'),
      prefix: 'auth',
      analytics: true,
    })
  : null;

/**
 * Self-serve signup limiter — guards POST /api/users/bootstrap, the write
 * that creates a `users/{uid}` doc (i.e. a row in the admin user table).
 * Account creation from a single IP is a rare event, so this is far tighter
 * than the general auth limiter — it blunts a bot spraying signups without
 * touching a human onboarding their team.
 * Prod: 10/hr per IP. Dev: 100/hr to keep local iteration unblocked.
 */
export const signupRateLimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(isDevEnv ? 100 : 10, '1 h'),
      prefix: 'signup',
      analytics: true,
    })
  : null;

/**
 * Rate limiter for token exchange / device code operations
 * Prod: 60/hr (supports bulk deployment of many machines from one IP)
 * Dev: 200/hr (allows rapid iteration during testing)
 */
export const tokenExchangeRateLimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(isDevEnv ? 200 : 60, '1 h'),
      prefix: 'token-exchange',
      analytics: true,
    })
  : null;

/**
 * Token refresh rate limiter (more lenient)
 * Allows 120 refreshes per hour per IP (agents refresh every hour,
 * so 120 supports ~120 machines behind one NAT)
 */
export const tokenRefreshRateLimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(120, '1 h'),
      prefix: 'token-refresh',
      analytics: true,
    })
  : null;

/**
 * User-based rate limiter for authenticated operations
 * Allows 10 operations per hour per user
 */
export const userRateLimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(60, '1 h'),
      prefix: 'user-ops',
      analytics: true,
    })
  : null;

/**
 * Agent alert rate limiter
 * Allows 5 alerts per hour per IP — prevents a broken agent from spamming emails
 */
export const agentAlertRateLimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(5, '1 h'),
      prefix: 'agent-alert',
      analytics: true,
    })
  : null;

/**
 * Installer upload rate limiter
 * Prod: 5 uploads per hour per IP (prevent storage abuse)
 * Dev: 30 per hour (allows iterating without hitting walls)
 */
export const uploadRateLimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(isDevEnv ? 30 : 5, '1 h'),
      prefix: 'upload',
      analytics: true,
    })
  : null;

/**
 * API key consumer rate limiter (higher limits for automated testing/CI)
 * Allows 300 operations per hour per IP
 */
export const apiRateLimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(300, '1 h'),
      prefix: 'api-ops',
      analytics: true,
    })
  : null;

/**
 * Process alert rate limiter
 * Allows 3 alerts per hour per machineId:processName combo — prevents crash-loop spam
 */
export const processAlertRateLimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(3, '1 h'),
      prefix: 'process-alert',
      analytics: true,
    })
  : null;

/**
 * Display alert rate limiter — 1 per hour per (machineId, eventType).
 * Mirrors the process-alert convention so the agent's alert dispatch path
 * has a uniform back-pressure model regardless of category. The drift event
 * gets a tighter window via `displayDriftRateLimit` below; everything else
 * uses this default.
 */
export const displayAlertRateLimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(1, '1 h'),
      prefix: 'display-alert',
      analytics: true,
    })
  : null;

/**
 * Drift-specific limiter at 1 per 4h. Drift events flap the most under
 * real-world conditions (rack vibration, EDID handshake retries, intermittent
 * cable issues) — a 1h window would still let an unstable cable email the
 * operator six times a day. The 4h window keeps drift signal alive without
 * burying the operator's inbox in noise from a single bad piece of hardware.
 */
export const displayDriftRateLimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(1, '4 h'),
      prefix: 'display-drift',
      analytics: true,
    })
  : null;

/**
 * Pick the right display-event rate limiter for a given event type. Drift
 * gets the tighter 4h window; every other display event uses the default
 * 1h limiter. Returns `null` when Redis isn't configured (mirrors the
 * existing limiters' nullability so callers can short-circuit).
 */
export function getDisplayAlertRateLimit(eventType: string) {
  return eventType === 'display_drift'
    ? displayDriftRateLimit
    : displayAlertRateLimit;
}

/**
 * Extract the client IP from a request, resistant to header spoofing.
 *
 * A client can set any request header, so header precedence runs from
 * infrastructure-controlled (unforgeable) to weakest — the only safe sources
 * are ones a trusted hop OVERWRITES or APPENDS:
 *
 *   1. `CF-Connecting-IP` — Cloudflare rewrites this at its edge on every
 *      request, so a client-supplied value never survives. owlette.app is
 *      fronted by a Cloudflare load balancer (see `infra/cloudflare/`,
 *      Railway primary + Vercel standby), making this authoritative in prod.
 *   2. `X-Forwarded-For`, read RIGHT-TO-LEFT. Each proxy APPENDS the address
 *      it received the connection from, so the right-most entry is the one our
 *      own edge added; everything to its left is whatever the client
 *      pre-seeded. Taking the LEFT-most (the previous behaviour) let a caller
 *      rotate `X-Forwarded-For` to mint a fresh rate-limit bucket per request
 *      and defeat the per-IP cap (issue #23). We take the right-most entry,
 *      which the single trusted hop in front of the app (Railway/Vercel edge,
 *      when Cloudflare is not fronting — e.g. local/dev) controls.
 *   3. `X-Real-IP` / `X-Railway-IP` — single-value proxy headers.
 *   4. `'unknown'` — no usable signal; such callers share one bucket.
 *
 * The chosen value is shape-clamped (IP charset, ≤64 chars) so a malformed
 * header can't become an oversized or injected rate-limit key.
 */
export function getClientIp(request: NextRequest): string {
  const cfConnectingIp = request.headers.get('cf-connecting-ip');
  if (cfConnectingIp) {
    return normalizeIp(cfConnectingIp);
  }

  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    // Right-most = appended by the trusted edge closest to us; entries to its
    // left are client-controlled. See the doc comment above.
    const ips = forwardedFor.split(',');
    return normalizeIp(ips[ips.length - 1]);
  }

  const realIp = request.headers.get('x-real-ip');
  if (realIp) {
    return normalizeIp(realIp);
  }

  // Railway-specific header
  const railwayIp = request.headers.get('x-railway-ip');
  if (railwayIp) {
    return normalizeIp(railwayIp);
  }

  // Fallback to connection IP (may not work in serverless)
  return 'unknown';
}

/**
 * Trim and shape-clamp an IP token. Returns 'unknown' when the value isn't
 * IP-like, so a junk or hostile header can't become a Redis rate-limit key.
 * Accepts the IPv4/IPv6 charset only (digits, hex, '.', ':').
 */
function normalizeIp(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || !/^[0-9a-fA-F.:]+$/.test(trimmed)) {
    return 'unknown';
  }
  return trimmed.slice(0, 64);
}

/**
 * Simple in-memory rate limiter as fallback when Redis is unavailable.
 * Uses a sliding window approach with automatic cleanup.
 */
const inMemoryStore = new Map<string, { count: number; resetAt: number }>();
const IN_MEMORY_WINDOW_MS = 60_000; // 1 minute
const IN_MEMORY_MAX_REQUESTS = 15; // per window per identifier

function checkInMemoryRateLimit(identifier: string): {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
  retryAfter?: number;
} {
  const now = Date.now();
  const entry = inMemoryStore.get(identifier);

  if (!entry || now >= entry.resetAt) {
    const resetAt = now + IN_MEMORY_WINDOW_MS;
    inMemoryStore.set(identifier, { count: 1, resetAt });
    return {
      success: true,
      limit: IN_MEMORY_MAX_REQUESTS,
      remaining: IN_MEMORY_MAX_REQUESTS - 1,
      reset: resetAt,
    };
  }

  entry.count++;
  const remaining = Math.max(0, IN_MEMORY_MAX_REQUESTS - entry.count);
  if (entry.count > IN_MEMORY_MAX_REQUESTS) {
    return {
      success: false,
      limit: IN_MEMORY_MAX_REQUESTS,
      remaining: 0,
      reset: entry.resetAt,
      retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }
  return {
    success: true,
    limit: IN_MEMORY_MAX_REQUESTS,
    remaining,
    reset: entry.resetAt,
  };
}

// Periodically clean up expired entries to prevent memory leaks
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of inMemoryStore) {
    if (now >= entry.resetAt) {
      inMemoryStore.delete(key);
    }
  }
}, 60_000);
if (typeof cleanupTimer.unref === 'function') {
  cleanupTimer.unref();
}

/**
 * Check rate limit and return result
 * @param ratelimiter - The Ratelimit instance to use
 * @param identifier - Unique identifier (IP address, user ID, etc.)
 * @returns Rate limit result with success/failure and metadata
 */
export async function checkRateLimit(
  ratelimiter: Ratelimit | null,
  identifier: string
): Promise<{
  success: boolean;
  limit?: number;
  remaining?: number;
  reset?: number;
  retryAfter?: number;
}> {
  // E2E escape hatch: Playwright runs many back-to-back admin API calls
  // across specs, which trips the 15/min in-memory bucket and causes
  // flaky 429s. Only honored when explicitly set in the webServer env
  // (playwright.config.ts) — production ignores this var entirely.
  if (process.env.E2E_DISABLE_RATE_LIMIT === 'true') {
    return { success: true };
  }

  // If rate limiting is disabled (no Redis configured), use in-memory fallback
  if (!ratelimiter) {
    return checkInMemoryRateLimit(identifier);
  }

  try {
    const result = await ratelimiter.limit(identifier);

    return {
      success: result.success,
      limit: result.limit,
      remaining: result.remaining,
      reset: result.reset,
      retryAfter: result.success ? undefined : Math.ceil((result.reset - Date.now()) / 1000),
    };
  } catch (error) {
    console.error('[RateLimit] Redis error, falling back to in-memory rate limit:', error);
    // Fall back to in-memory rate limiting instead of allowing all requests
    return checkInMemoryRateLimit(identifier);
  }
}

/**
 * Reason taxonomy for 429 responses. Emitted as the
 * `Roost-Rate-Limited-Reason` header so clients can decide whether a
 * retry is worthwhile and over what horizon.
 */
export type RateLimitedReason =
  | 'global-rate'
  | 'endpoint-rate'
  | 'key-rate'
  | 'site-concurrency';

/**
 * Format rate limit headers for HTTP response.
 *
 * Emits BOTH the IETF draft-standard names (`RateLimit-*` — no `X-`
 * prefix) and the legacy `X-RateLimit-*` names so existing clients keep
 * working through the transition.
 */
export function getRateLimitHeaders(result: {
  limit?: number;
  remaining?: number;
  reset?: number;
  retryAfter?: number;
  reason?: RateLimitedReason;
}): Record<string, string> {
  const headers: Record<string, string> = {};

  if (result.limit !== undefined) {
    headers['RateLimit-Limit'] = result.limit.toString();
    headers['X-RateLimit-Limit'] = result.limit.toString();
  }

  if (result.remaining !== undefined) {
    headers['RateLimit-Remaining'] = result.remaining.toString();
    headers['X-RateLimit-Remaining'] = result.remaining.toString();
  }

  if (result.reset !== undefined) {
    const deltaSeconds = Math.max(0, Math.ceil((result.reset - Date.now()) / 1000));
    headers['RateLimit-Reset'] = deltaSeconds.toString();
    headers['X-RateLimit-Reset'] = result.reset.toString();
  }

  if (result.retryAfter !== undefined) {
    headers['Retry-After'] = result.retryAfter.toString();
  }

  if (result.reason) {
    headers['Roost-Rate-Limited-Reason'] = result.reason;
  }

  return headers;
}
