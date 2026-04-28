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

import type { NextRequest, NextResponse } from 'next/server';
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
  type RateLimitedReason,
} from './rateLimit';
import { problem, ProblemType } from './apiErrors';

type RateLimitStrategy = 'auth' | 'tokenExchange' | 'tokenRefresh' | 'user' | 'agentAlert' | 'upload' | 'api';
type IdentifierType = 'ip' | 'user';

interface RateLimitOptions {
  strategy: RateLimitStrategy;
  identifier: IdentifierType;
  getUserId?: (request: NextRequest) => Promise<string | null>;
  /** Override the derived reason used in the Roost-Rate-Limited-Reason header. */
  reason?: RateLimitedReason;
}

function reasonFor(strategy: RateLimitStrategy, identifier: IdentifierType): RateLimitedReason {
  if (strategy === 'user' || strategy === 'api') {
    return identifier === 'user' ? 'key-rate' : 'endpoint-rate';
  }
  if (strategy === 'auth' || strategy === 'tokenExchange' || strategy === 'tokenRefresh') {
    return 'endpoint-rate';
  }
  if (strategy === 'upload' || strategy === 'agentAlert') {
    return 'endpoint-rate';
  }
  return 'global-rate';
}

function requestHasApiKeyCredential(request: NextRequest): boolean {
  const queryOrHeader =
    request.nextUrl.searchParams.get('api_key') ||
    request.headers.get('x-api-key') ||
    null;
  if (queryOrHeader?.startsWith('owk_')) return true;

  const auth = request.headers.get('authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return Boolean(match?.[1]?.startsWith('owk_'));
}

async function getApiKeyRateLimitIdentifier(request: NextRequest): Promise<string | null> {
  if (!requestHasApiKeyCredential(request)) return null;

  try {
    const { resolveApiKeyRateLimitIdentity } = await import('@/lib/apiAuth.server');
    return await resolveApiKeyRateLimitIdentity(request);
  } catch {
    return null;
  }
}

/**
 * Rate limit middleware wrapper.
 *
 * Generic over any extra arguments Next.js passes to the route (e.g. the
 * App-Router `context` object containing dynamic-route params). Extra
 * args are forwarded to the handler unchanged.
 *
 * @param handler - The API route handler function
 * @param options - Rate limiting configuration
 * @returns Wrapped handler with rate limiting
 */
export function withRateLimit<TArgs extends unknown[]>(
  handler: (request: NextRequest, ...rest: TArgs) => Promise<NextResponse>,
  options: RateLimitOptions
) {
  return async (request: NextRequest, ...rest: TArgs): Promise<NextResponse> => {
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
    let usedApiKeyIdentifier = false;

    if (options.identifier === 'ip') {
      const apiKeyIdentifier = options.strategy === 'api'
        ? await getApiKeyRateLimitIdentifier(request)
        : null;
      usedApiKeyIdentifier = !!apiKeyIdentifier;
      identifier = apiKeyIdentifier || getClientIp(request);
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
    const reason = options.reason ?? (usedApiKeyIdentifier ? 'key-rate' : reasonFor(options.strategy, options.identifier));

    // If rate limit exceeded, return 429 response
    if (!result.success) {
      console.warn(`[RateLimit] Rate limit exceeded for ${options.strategy}:`, identifier);

      const headers = getRateLimitHeaders({ ...result, reason });

      const retryAfter = result.retryAfter ?? 1;
      const message = `Too many requests. Please try again in ${retryAfter} seconds.`;

      return problem(
        {
          type: ProblemType.RateLimited,
          title: 'rate limited',
          status: 429,
          detail: message,
          retryAfter,
          error: 'Rate limit exceeded',
          message,
        },
        headers,
      );
    }

    // Rate limit passed, call the handler
    const response = await handler(request, ...rest);

    // Add rate limit headers to successful response (counters only — no
    // Retry-After or reason on 200s).
    const headers = getRateLimitHeaders({
      limit: result.limit,
      remaining: result.remaining,
      reset: result.reset,
    });
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
