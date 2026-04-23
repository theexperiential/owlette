/**
 * RFC 7807 problem+json error envelope for roost routes (project distribution v2):
 * /api/chunks/*, /api/roosts/*, and the agent-facing sync endpoints.
 *
 * https://datatracker.ietf.org/doc/html/rfc7807
 *
 * Differs from the legacy /lib/apiErrorResponse.ts envelope (`{error: string}`).
 * v2 routes adopt this for consistent machine-readable errors with type URIs,
 * stable codes, and request IDs for trace correlation.
 *
 * Usage:
 *
 *   import { problem, problemFromError, ProblemType } from '@/lib/apiErrors';
 *
 *   if (!chunks?.length) {
 *     return problem({
 *       type: ProblemType.ValidationFailed,
 *       title: 'invalid request',
 *       status: 400,
 *       detail: 'request body must include a non-empty `hashes` array',
 *     });
 *   }
 *
 *   } catch (err) {
 *     return problemFromError(err, 'v2/chunks/check');
 *   }
 */
import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';

/**
 * Stable problem-type URIs. These are public identifiers consumed by API
 * clients to switch on error semantics — keep them stable across versions.
 */
export const ProblemType = {
  ValidationFailed: 'https://owlette.app/problems/validation-failed',
  Unauthorized: 'https://owlette.app/problems/unauthorized',
  Forbidden: 'https://owlette.app/problems/forbidden',
  NotFound: 'https://owlette.app/problems/not-found',
  Conflict: 'https://owlette.app/problems/conflict',
  PreconditionFailed: 'https://owlette.app/problems/precondition-failed',
  PayloadTooLarge: 'https://owlette.app/problems/payload-too-large',
  RateLimited: 'https://owlette.app/problems/rate-limited',
  QuotaExceeded: 'https://owlette.app/problems/quota-exceeded',
  Internal: 'https://owlette.app/problems/internal-error',
  ServiceUnavailable: 'https://owlette.app/problems/service-unavailable',
} as const;

export type ProblemTypeUri = typeof ProblemType[keyof typeof ProblemType];

export interface ProblemDetails {
  /** absolute URI identifying the problem type. SHOULD be dereferenceable to docs. */
  type: ProblemTypeUri | string;
  /** short, human-readable summary. SHOULD NOT change between occurrences. */
  title: string;
  /** HTTP status code, mirrored in the response status. */
  status: number;
  /** human-readable explanation specific to this occurrence. */
  detail?: string;
  /** URI reference identifying the specific occurrence. */
  instance?: string;
  /** correlation id for log/trace lookup. */
  requestId?: string;
  /** field-level errors when status=400/422; key is dotted JSON path. */
  errors?: Record<string, string[]>;
  /** any additional implementation-specific fields. */
  [key: string]: unknown;
}

/**
 * Build a NextResponse with the RFC 7807 envelope and the right Content-Type.
 *
 * The Content-Type is `application/problem+json` per the RFC. Clients that
 * accept `application/json` will still parse it correctly.
 */
export function problem(details: ProblemDetails, headers?: HeadersInit): NextResponse {
  // `??` only catches null/undefined; an empty string passed by a caller
  // would otherwise become an invalid `X-Request-Id: ''` header.
  const callerRid = typeof details.requestId === 'string' && details.requestId.length > 0
    ? details.requestId
    : undefined;
  const requestId = callerRid ?? crypto.randomUUID();
  const body = { ...details, requestId };

  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'application/problem+json; charset=utf-8');
  responseHeaders.set('X-Request-Id', requestId);

  return new NextResponse(JSON.stringify(body), {
    status: details.status,
    headers: responseHeaders,
  });
}

/**
 * Wrap an unexpected error into a 500 problem+json response.
 *
 * **DOES NOT pass the error message through to the client.** v2 routes
 * intentionally avoid the `handleError()` mapping used by v1 because
 * that mapping leaks error categories (e.g. "permission-denied" vs
 * "not-found") that can be used adversarially to confirm resource
 * existence. Instead: log + Sentry the real error server-side; return
 * a generic message + requestId for the client to quote in support.
 *
 * For known error categories (validation, auth, quota), use `problem()`
 * directly with the appropriate ProblemType — those carry safe detail.
 */
export function problemFromError(
  err: unknown,
  context: string,
  status = 500,
): NextResponse {
  // server-side observability: log + sentry with full context. never
  // surfaces to the client.
  if (err instanceof Error) {
    Sentry.captureException(err, { tags: { context, surface: 'v2-api' } });
    console.error(`[v2-api error - ${context}]`, err.message, err.stack);
  } else {
    Sentry.captureMessage(`non-error thrown: ${String(err).slice(0, 200)}`, {
      tags: { context, surface: 'v2-api' },
    });
    console.error(`[v2-api non-error - ${context}]`, err);
  }
  return problem({
    type: ProblemType.Internal,
    title: 'internal error',
    status,
    detail: 'an internal error occurred. quote the requestId when contacting support.',
    instance: context,
  });
}

/* ─── convenience constructors for common cases ───────────────────────── */

export function problemValidation(detail: string, errors?: Record<string, string[]>): NextResponse {
  return problem({
    type: ProblemType.ValidationFailed,
    title: 'validation failed',
    status: 400,
    detail,
    errors,
  });
}

export function problemUnauthorized(detail = 'authentication required'): NextResponse {
  return problem({
    type: ProblemType.Unauthorized,
    title: 'unauthorized',
    status: 401,
    detail,
  });
}

export function problemForbidden(detail = 'access denied'): NextResponse {
  return problem({
    type: ProblemType.Forbidden,
    title: 'forbidden',
    status: 403,
    detail,
  });
}

export function problemNotFound(detail = 'resource not found'): NextResponse {
  return problem({
    type: ProblemType.NotFound,
    title: 'not found',
    status: 404,
    detail,
  });
}

export function problemRateLimited(retryAfterSeconds: number, detail?: string): NextResponse {
  // clamp non-positive to 1 (semantically "retry immediately"); cap to 1h
  // (arbitrary upper bound to surface bugs vs. let through obvious
  // garbage like Number.MAX_SAFE_INTEGER).
  const safe = Math.max(1, Math.min(3600, Math.floor(retryAfterSeconds || 0)));
  return problem(
    {
      type: ProblemType.RateLimited,
      title: 'rate limited',
      status: 429,
      detail: detail ?? `try again in ${safe} seconds`,
      retryAfter: safe,
    },
    { 'Retry-After': String(safe) },
  );
}

export function problemQuotaExceeded(detail: string, upgradeUrl?: string): NextResponse {
  return problem({
    type: ProblemType.QuotaExceeded,
    title: 'storage quota exceeded',
    status: 402,
    detail,
    ...(upgradeUrl ? { upgradeUrl } : {}),
  });
}
