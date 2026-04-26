/**
 * Idempotency-Key handling for mutating POST routes.
 *
 * Stripe-style (https://stripe.com/docs/api/idempotent_requests): a client
 * sends `Idempotency-Key: <opaque>` with a mutating POST. If the same
 * user re-sends the same key within 24 hours AND the request body is
 * byte-identical, we replay the cached response instead of executing
 * the handler. If the body differs, we reject 422 `idempotency_key_mismatch`.
 *
 * Cache key: `{userId, environment, idempotencyKey}` — hashed to a short
 * firestore doc id. The `bodyHash` is stored on the doc for mismatch
 * detection, so different-body retries on the same key don't silently
 * cache-hit.
 *
 * Retention is handled by `sweepExpiredIdempotencyCache` (functions/),
 * which runs daily and deletes entries past `expiresAt`.
 *
 * Middleware note: the repo's `proxy.ts` matcher excludes `/api/*`, so
 * this ships as a helper that mutating routes call explicitly rather
 * than as Next.js middleware.
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

/** What the caller should do after checkIdempotency(). */
export type IdempotencyCheckResult =
  | { mode: 'disabled' } // no idempotency-key header present — proceed without recording
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
  userId: string;
  environment: IdempotencyContext['environment'];
}

interface CachedDoc {
  userId: string;
  environment: string;
  key: string;
  bodyHash: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  expiresAt: number;
  createdAt: FirebaseFirestore.Timestamp | number;
}

/**
 * Validate the Idempotency-Key header and look up a cached response.
 *
 * `rawBody` is the string form the handler already read (to avoid re-
 * consuming a stream). If no body, pass an empty string — the bodyHash
 * is still computed so mismatch detection is consistent.
 */
export async function checkIdempotency(
  request: NextRequest,
  ctx: IdempotencyContext,
  rawBody: string,
): Promise<IdempotencyCheckResult> {
  const rawKey = request.headers.get(IDEMPOTENCY_HEADER);
  if (!rawKey || rawKey.trim().length === 0) {
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

  const cacheDocId = hashCacheKey(ctx.userId, ctx.environment, key);
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
    // expired or malformed — fall through to proceed; save will overwrite.
  }

  return {
    mode: 'proceed',
    token: {
      cacheDocId,
      key,
      bodyHash,
      userId: ctx.userId,
      environment: ctx.environment,
    },
  };
}

/**
 * Persist the handler's response under the idempotency key. Reads the
 * response body + headers so replays are byte-for-byte identical (save
 * for the `Idempotent-Replayed` marker header we add).
 */
export async function saveIdempotency(
  token: IdempotencyToken,
  response: NextResponse,
): Promise<void> {
  try {
    // Don't cache error responses — callers expect to retry and get a
    // fresh attempt. 4xx/5xx still return, just aren't cached.
    if (response.status >= 400) return;

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
      status: response.status,
      headers,
      body: bodyText,
      expiresAt: now + IDEMPOTENCY_TTL_MS,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    // Cache persistence is best-effort — a replay miss just means the
    // next retry executes the handler again, which is the pre-idempotency
    // default. Don't fail the request over it.
    console.warn(
      `[idempotency] failed to persist cache: ${(err as Error).message}`,
    );
  }
}

/** Deterministic short doc id for the `{userId, env, key}` tuple. */
function hashCacheKey(
  userId: string,
  environment: string,
  key: string,
): string {
  return crypto
    .createHash('sha256')
    .update(`${userId}|${environment}|${key}`)
    .digest('hex');
}

function rebuildResponse(data: CachedDoc): NextResponse {
  const response = new NextResponse(data.body, {
    status: data.status,
    headers: data.headers,
  });
  // Stripe-style `Idempotent-Replayed: true` so observant callers know
  // this was a cache hit, not a fresh execution.
  response.headers.set('Idempotent-Replayed', 'true');
  return response;
}

/**
 * High-level wrapper for the standard {check → handler → save} flow.
 *
 * Use this in any route that needs idempotency:
 *
 * ```ts
 * return withIdempotency(
 *   request,
 *   { userId: auth.userId, environment: auth.auth.keyContext?.environment ?? 'unknown' },
 *   parsed.raw,
 *   async () => buildResponseHere(),
 * );
 * ```
 *
 * Behavior matches the two-step `checkIdempotency` + `saveIdempotency`
 * pattern already in use across roost routes — short-circuits to cached
 * replay / mismatch / invalid-key responses, otherwise runs the handler
 * and saves a successful response. Caching only applies to 2xx-3xx
 * responses; errors are returned but never cached.
 *
 * Routes that need to add headers to the saved response (e.g.
 * `applyAuthDeprecations`) should do so inside the handler before
 * returning — the wrapper saves whatever NextResponse the handler emits.
 */
export async function withIdempotency(
  request: NextRequest,
  ctx: IdempotencyContext,
  rawBody: string,
  handler: () => Promise<NextResponse>,
): Promise<NextResponse> {
  const idem = await checkIdempotency(request, ctx, rawBody);
  if (idem.mode === 'invalid' || idem.mode === 'replay' || idem.mode === 'mismatch') {
    return idem.response;
  }

  const response = await handler();

  if (idem.mode === 'proceed') {
    await saveIdempotency(idem.token, response);
  }

  return response;
}
