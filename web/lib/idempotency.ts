/**
 * Stripe-style Idempotency-Key for mutating POSTs
 * (https://stripe.com/docs/api/idempotent_requests): same key within 24h with a
 * byte-identical body replays the cached response; a different body is 422
 * `idempotency_key_mismatch`.
 *
 * Doc id hashes `{userId, environment, key, method, path, query}`; `bodyHash`
 * lives on the doc so different-body retries cannot silently cache-hit.
 * `sweepExpiredIdempotencyCache` (functions/) deletes entries past `expiresAt`.
 *
 * A helper, not middleware — `proxy.ts`'s matcher excludes `/api/*`.
 */

import crypto from 'crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  problem,
  ProblemType,
} from '@/lib/apiErrors';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_MAX_KEY_LENGTH = 255;
export const IDEMPOTENCY_COLLECTION = 'idempotency_cache';

export interface IdempotencyContext {
  userId: string;
  /** 'live' / 'test' for api-key callers; 'unknown' for session/id-token. */
  environment: 'live' | 'test' | 'unknown';
}

export interface IdempotencyOptions {
  /** Reject the request when Idempotency-Key is missing or blank. */
  requireKey?: boolean;
}

/** What the caller should do after checkIdempotency(). */
export type IdempotencyCheckResult =
  | { mode: 'disabled' } // no idempotency-key header present — proceed without recording
  | { mode: 'missing'; response: NextResponse } // 400 — required header was not supplied
  | { mode: 'invalid'; response: NextResponse } // 400 — bad key format
  | { mode: 'replay'; response: NextResponse } // cached hit — return the replayed response
  | { mode: 'mismatch'; response: NextResponse } // 422 — key reused with different body
  | {
      mode: 'proceed';
      /** Hand back to saveIdempotency after the handler produces a response. */
      token: IdempotencyToken;
    };

export interface IdempotencyToken {
  cacheDocId: string;
  key: string;
  bodyHash: string;
  method: string;
  path: string;
  query: string;
  userId: string;
  environment: IdempotencyContext['environment'];
}

interface CachedDoc {
  userId: string;
  environment: string;
  key: string;
  bodyHash: string;
  method: string;
  path: string;
  query: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  expiresAt: number;
  createdAt: FirebaseFirestore.Timestamp | number;
}

/**
 * Validate the header and look up a cached response. `rawBody` is the string
 * the handler already read (the stream cannot be re-consumed); pass '' when
 * there is none — the hash is still computed so mismatch detection is uniform.
 */
export async function checkIdempotency(
  request: NextRequest,
  ctx: IdempotencyContext,
  rawBody: string,
  options: IdempotencyOptions = {},
): Promise<IdempotencyCheckResult> {
  const rawKey = request.headers.get(IDEMPOTENCY_HEADER);
  if (!rawKey || rawKey.trim().length === 0) {
    if (options.requireKey) {
      return {
        mode: 'missing',
        response: problem({
          type: ProblemType.ValidationFailed,
          title: 'idempotency key required',
          status: 400,
          detail: `${IDEMPOTENCY_HEADER} is required for this mutation`,
          code: 'idempotency_key_required',
          param: IDEMPOTENCY_HEADER,
          errors: { [IDEMPOTENCY_HEADER]: ['required'] },
        }),
      };
    }
    return { mode: 'disabled' };
  }

  const key = rawKey.trim();
  if (key.length > IDEMPOTENCY_MAX_KEY_LENGTH) {
    return {
      mode: 'invalid',
      response: problem({
        type: ProblemType.ValidationFailed,
        title: 'idempotency key too long',
        status: 400,
        detail: `${IDEMPOTENCY_HEADER} must be ≤ ${IDEMPOTENCY_MAX_KEY_LENGTH} chars`,
        code: 'idempotency_key_invalid',
      }),
    };
  }

  const routeScope = routeScopeForRequest(request);
  const cacheDocId = hashCacheKey(ctx.userId, ctx.environment, key, routeScope);
  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');

  const db = getAdminDb();
  const docRef = db.collection(IDEMPOTENCY_COLLECTION).doc(cacheDocId);
  const snap = await docRef.get();

  if (snap.exists) {
    const data = snap.data() as Partial<CachedDoc>;
    const expired =
      typeof data.expiresAt === 'number' && Date.now() >= data.expiresAt;
    if (!expired && data.bodyHash && data.status) {
      if (data.bodyHash !== bodyHash) {
        return {
          mode: 'mismatch',
          response: problem({
            type: ProblemType.ValidationFailed,
            title: 'idempotency key mismatch',
            status: 422,
            detail: `${IDEMPOTENCY_HEADER} '${key}' was previously used with a different request body; reuse requires the identical body`,
            code: 'idempotency_key_mismatch',
          }),
        };
      }
      return {
        mode: 'replay',
        response: rebuildResponse(data as CachedDoc),
      };
    }
    // Expired or malformed — proceed; save overwrites.
  }

  return {
    mode: 'proceed',
    token: {
      cacheDocId,
      key,
      bodyHash,
      method: routeScope.method,
      path: routeScope.path,
      query: routeScope.query,
      userId: ctx.userId,
      environment: ctx.environment,
    },
  };
}

/** Persist body + headers so replays are byte-identical bar `Idempotent-Replayed`. */
export async function saveIdempotency(
  token: IdempotencyToken,
  response: NextResponse,
): Promise<void> {
  try {
    // Errors are returned but never cached — a retry must re-execute.
    if (response.status >= 400) return;

    // Never cache streams: `clone().text()` buffers the whole body, breaking
    // streaming for the original consumer and risking OOM. Replays re-run.
    const contentType = response.headers.get('content-type') || '';
    if (
      contentType.includes('text/event-stream') ||
      contentType.includes('application/x-ndjson') ||
      response.headers.get('transfer-encoding') === 'chunked'
    ) {
      return;
    }

    const bodyText = await response.clone().text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const db = getAdminDb();
    const now = Date.now();
    const docRef = db.collection(IDEMPOTENCY_COLLECTION).doc(token.cacheDocId);
    await docRef.set({
      userId: token.userId,
      environment: token.environment,
      key: token.key,
      bodyHash: token.bodyHash,
      method: token.method,
      path: token.path,
      query: token.query,
      status: response.status,
      headers,
      body: bodyText,
      expiresAt: now + IDEMPOTENCY_TTL_MS,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    // Best-effort: a miss just re-executes the handler on the next retry.
    console.warn(
      `[idempotency] failed to persist cache: ${(err as Error).message}`,
    );
  }
}

interface IdempotencyRouteScope {
  method: string;
  path: string;
  query: string;
}

function routeScopeForRequest(request: NextRequest): IdempotencyRouteScope {
  const url = request.nextUrl ?? new URL(request.url);
  return {
    method: request.method.toUpperCase(),
    path: url.pathname,
    query: url.search,
  };
}

/** Deterministic short doc id for the `{userId, env, key, route}` tuple. */
function hashCacheKey(
  userId: string,
  environment: string,
  key: string,
  routeScope: IdempotencyRouteScope,
): string {
  return crypto
    .createHash('sha256')
    .update(`${userId}|${environment}|${key}|${routeScope.method}|${routeScope.path}|${routeScope.query}`)
    .digest('hex');
}

function rebuildResponse(data: CachedDoc): NextResponse {
  const response = new NextResponse(data.body, {
    status: data.status,
    headers: data.headers,
  });
  // Marks a cache hit rather than a fresh execution.
  response.headers.set('Idempotent-Replayed', 'true');
  return response;
}

/**
 * `checkIdempotency` → handler → `saveIdempotency` in one call: short-circuits
 * to replay / mismatch / invalid-key, otherwise runs the handler and caches a
 * 2xx-3xx response.
 *
 * Headers to be cached (e.g. `applyAuthDeprecations`) must be added inside the
 * handler — the wrapper saves whatever NextResponse it returns.
 */
export async function withIdempotency(
  request: NextRequest,
  ctx: IdempotencyContext,
  rawBody: string,
  handler: () => Promise<NextResponse>,
  options: IdempotencyOptions = {},
): Promise<NextResponse> {
  const idem = await checkIdempotency(request, ctx, rawBody, options);
  if (
    idem.mode === 'missing' ||
    idem.mode === 'invalid' ||
    idem.mode === 'replay' ||
    idem.mode === 'mismatch'
  ) {
    return idem.response;
  }

  const response = await handler();

  if (idem.mode === 'proceed') {
    await saveIdempotency(idem.token, response);
  }

  return response;
}
