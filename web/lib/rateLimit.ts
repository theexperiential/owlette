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
 * Extract client IP from NextRequest
 * Handles proxies (Railway, Cloudflare, etc.)
 */
export function getClientIp(request: NextRequest): string {
  // Check common proxy headers
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    // x-forwarded-for can be a comma-separated list: "client, proxy1, proxy2"
    const ips = forwardedFor.split(',');
    return ips[0].trim();
  }

  const realIp = request.headers.get('x-real-ip');
  if (realIp) {
    return realIp;
  }

  // Railway-specific header
  const railwayIp = request.headers.get('x-railway-ip');
  if (railwayIp) {
    return railwayIp;
  }

  // Fallback to connection IP (may not work in serverless)
  return 'unknown';
}

/**
 * Simple in-memory rate limiter as fallback when Redis is unavailable.
 * Uses a sliding window approach with automatic cleanup.
 */
const inMemoryStore = new Map<string, { count: number; resetAt: number }>();
const IN_MEMORY_WINDOW_MS = 60_000; // 1 minute
const IN_MEMORY_MAX_REQUESTS = 15; // per window per identifier

function checkInMemoryRateLimit(identifier: string): { success: boolean } {
  const now = Date.now();
  const entry = inMemoryStore.get(identifier);

  if (!entry || now >= entry.resetAt) {
    inMemoryStore.set(identifier, { count: 1, resetAt: now + IN_MEMORY_WINDOW_MS });
    return { success: true };
  }

  entry.count++;
  if (entry.count > IN_MEMORY_MAX_REQUESTS) {
    return { success: false };
  }
  return { success: true };
}

// Periodically clean up expired entries to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of inMemoryStore) {
    if (now >= entry.resetAt) {
      inMemoryStore.delete(key);
    }
  }
}, 60_000);

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
 * Format rate limit headers for HTTP response
 */
export function getRateLimitHeaders(result: {
  limit?: number;
  remaining?: number;
  reset?: number;
  retryAfter?: number;
}): Record<string, string> {
  const headers: Record<string, string> = {};

  if (result.limit !== undefined) {
    headers['X-RateLimit-Limit'] = result.limit.toString();
  }

  if (result.remaining !== undefined) {
    headers['X-RateLimit-Remaining'] = result.remaining.toString();
  }

  if (result.reset !== undefined) {
    headers['X-RateLimit-Reset'] = result.reset.toString();
  }

  if (result.retryAfter !== undefined) {
    headers['Retry-After'] = result.retryAfter.toString();
  }

  return headers;
}
