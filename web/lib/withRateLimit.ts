/**
 * Higher-Order Function for Rate Limiting API Routes
 *
 * Wraps Next.js API route handlers with rate limiting logic.
 * Supports both IP-based and user-based rate limiting.
 *
 * Usage:
 * ```typescript
 * export const POST = withRateLimit(
 *   async (request: NextRequest) => {
 *     // Your handler logic
 *     return NextResponse.json({ success: true });
 *   },
 *   {
 *     strategy: 'auth', // or 'tokenExchange', 'tokenRefresh', 'user'
 *     identifier: 'ip', // or 'user' for authenticated endpoints
 *   }
 * );
 * ```
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  authRateLimit,
  tokenExchangeRateLimit,
  tokenRefreshRateLimit,
  userRateLimit,
  agentAlertRateLimit,
  uploadRateLimit,
  apiRateLimit,
  getClientIp,
  checkRateLimit,
  getRateLimitHeaders,
} from './rateLimit';

type RateLimitStrategy = 'auth' | 'tokenExchange' | 'tokenRefresh' | 'user' | 'agentAlert' | 'upload' | 'api';
type IdentifierType = 'ip' | 'user';

interface RateLimitOptions {
  strategy: RateLimitStrategy;
  identifier: IdentifierType;
  getUserId?: (request: NextRequest) => Promise<string | null>; // Custom function to extract user ID
}

/**
 * Rate limit middleware wrapper
 * @param handler - The API route handler function
 * @param options - Rate limiting configuration
 * @returns Wrapped handler with rate limiting
 */
export function withRateLimit(
  handler: (request: NextRequest) => Promise<NextResponse>,
  options: RateLimitOptions
) {
  return async (request: NextRequest): Promise<NextResponse> => {
    // Select rate limiter based on strategy
    const ratelimiter =
      options.strategy === 'auth' ? authRateLimit :
      options.strategy === 'tokenExchange' ? tokenExchangeRateLimit :
      options.strategy === 'tokenRefresh' ? tokenRefreshRateLimit :
      options.strategy === 'user' ? userRateLimit :
      options.strategy === 'agentAlert' ? agentAlertRateLimit :
      options.strategy === 'upload' ? uploadRateLimit :
      options.strategy === 'api' ? apiRateLimit :
      null;

    // Determine identifier (IP or user ID)
    let identifier: string;

    if (options.identifier === 'ip') {
      identifier = getClientIp(request);
    } else if (options.identifier === 'user') {
      if (!options.getUserId) {
        console.error('[RateLimit] getUserId function required for user-based rate limiting');
        identifier = getClientIp(request); // Fallback to IP
      } else {
        const userId = await options.getUserId(request);
        identifier = userId || getClientIp(request); // Fallback to IP if no user
      }
    } else {
      identifier = getClientIp(request);
    }

    // Check rate limit
    const result = await checkRateLimit(ratelimiter, identifier);

    // If rate limit exceeded, return 429 response
    if (!result.success) {
      console.warn(`[RateLimit] Rate limit exceeded for ${options.strategy}:`, identifier);

      const headers = getRateLimitHeaders(result);

      return NextResponse.json(
        {
          error: 'Rate limit exceeded',
          retryAfter: result.retryAfter,
          message: `Too many requests. Please try again in ${result.retryAfter} seconds.`,
        },
        {
          status: 429,
          headers,
        }
      );
    }

    // Rate limit passed, call the handler

    const response = await handler(request);

    // Add rate limit headers to successful response
    const headers = getRateLimitHeaders(result);
    Object.entries(headers).forEach(([key, value]) => {
      response.headers.set(key, value);
    });

    return response;
  };
}

/**
 * Extract user ID from session cookie
 * Use this as the getUserId function for user-based rate limiting
 */
export async function getUserIdFromSession(request: NextRequest): Promise<string | null> {
  try {
    const { getSessionFromRequest } = await import('@/lib/sessionManager.server');
    const session = await getSessionFromRequest(request);
    return session.userId || null;
  } catch {
    // Session reading failed — fall back to IP-based rate limiting
    return null;
  }
}
