/**
 * API key minting helper for e2e specs against the public scoped API.
 *
 * The public API supports two auth modes per `web/lib/apiAuth.server.ts`:
 *
 *   1. Session / Firebase id-token (used by the dashboard)
 *   2. `Authorization: Bearer owk_<env>_<random>` API keys (used by SDKs / CLI)
 *
 * Most api-sprint route handlers funnel through one of the `requireXxxAuthAndScope`
 * helpers in `web/app/api/_shared.ts`. For e2e specs that hit those routes via
 * `request: APIRequestContext` (rather than driving a browser) the cleanest path
 * is to mint an api key. We do this by writing the `users/{uid}/api_keys/{keyId}`
 * record + the `api_keys/{keyHash}` lookup directly via the Admin SDK — exactly
 * the same shape `POST /api/keys` would have produced — bypassing the session
 * cookie requirement of that endpoint.
 *
 * The owner uid defaults to the canonical `superadmin` test user (`super-uid`)
 * because the `installer` and `user` resources require superadmin to mint
 * (per `SUPERADMIN_ONLY_RESOURCES` in `web/lib/apiKeyTypes.ts`); for non-platform
 * resources, callers can pass `admin-uid` instead.
 */
import crypto from 'crypto';
import type { APIRequestContext } from '@playwright/test';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from './emulator';
import type {
  ApiKeyEnvironment,
  ApiKeyLookup,
  ApiKeyRecord,
  ApiKeyScope,
} from '@/lib/apiKeyTypes';

export interface MintApiKeyOptions {
  ownerUid?: string;
  name?: string;
  scopes: ApiKeyScope[];
  environment?: ApiKeyEnvironment;
  ttlDays?: number;
}

export interface MintedApiKey {
  rawKey: string;
  keyId: string;
  keyHash: string;
  ownerUid: string;
  scopes: ApiKeyScope[];
  expiresAt: number;
}

/**
 * Mint a scoped api key directly into the emulator's Firestore. Returns the
 * raw `owk_*` key string the caller embeds in `Authorization: Bearer ...`,
 * plus the keyId for cleanup.
 */
export async function mintApiKey(opts: MintApiKeyOptions): Promise<MintedApiKey> {
  const ownerUid = opts.ownerUid ?? 'super-uid';
  const environment = opts.environment ?? 'test';
  const ttlDays = opts.ttlDays ?? 30;

  // Match POST /api/keys's key shape: `owk_<env>_<43 base64url chars>`.
  const keyRandom = crypto.randomBytes(32).toString('base64url');
  const rawKey = `owk_${environment}_${keyRandom}`;
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const keyId = crypto.randomUUID();
  const keyPrefix = rawKey.slice(0, 15);
  const now = Date.now();
  const expiresAt = now + ttlDays * 24 * 60 * 60 * 1000;

  const db = getAdminDb();
  const batch = db.batch();

  const record: Omit<ApiKeyRecord, 'createdAt'> & {
    createdAt: FirebaseFirestore.FieldValue;
  } = {
    name: opts.name ?? 'e2e-api-sprint-key',
    keyHash,
    keyPrefix,
    environment,
    scopes: opts.scopes,
    expiresAt,
    createdAt: FieldValue.serverTimestamp(),
    lastUsedAt: null,
  };

  batch.set(
    db.collection('users').doc(ownerUid).collection('api_keys').doc(keyId),
    record,
  );

  const lookup: ApiKeyLookup = {
    userId: ownerUid,
    keyId,
    environment,
    scopes: opts.scopes,
    expiresAt,
  };
  batch.set(db.collection('api_keys').doc(keyHash), lookup);

  await batch.commit();

  return { rawKey, keyId, keyHash, ownerUid, scopes: opts.scopes, expiresAt };
}

/**
 * Delete an api key from both Firestore docs. Safe to call multiple times —
 * delete() on a missing doc is a no-op.
 */
export async function revokeApiKey(key: MintedApiKey): Promise<void> {
  const db = getAdminDb();
  await Promise.all([
    db
      .collection('users')
      .doc(key.ownerUid)
      .collection('api_keys')
      .doc(key.keyId)
      .delete(),
    db.collection('api_keys').doc(key.keyHash).delete(),
  ]);
}

/**
 * Convenience: build an `Authorization: Bearer <rawKey>` header set with a
 * fresh `Idempotency-Key`. Pass `idempotencyKey: false` to suppress the
 * idempotency header (e.g. for GETs).
 */
export function authHeaders(
  key: MintedApiKey,
  idempotencyKey: string | false = crypto.randomUUID(),
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key.rawKey}`,
    'Content-Type': 'application/json',
  };
  if (idempotencyKey !== false) headers['Idempotency-Key'] = idempotencyKey;
  return headers;
}

/**
 * Convenience: same as authHeaders() but always emits a fresh uuid Idempotency-Key.
 * Useful when the caller wants a fresh replay-safe key per request without
 * wiring uuid generation each time.
 */
export function freshHeaders(key: MintedApiKey): Record<string, string> {
  return authHeaders(key, crypto.randomUUID());
}

/**
 * Tiny helper for the few specs that want to thread the api-key through
 * Playwright's APIRequestContext without re-creating headers each call.
 * Returns a wrapper that auto-attaches the auth header on every request.
 *
 * NB: each call still spawns a fresh `Idempotency-Key` — replay tests need to
 * pass an explicit header instead.
 */
export function bindRequest(
  request: APIRequestContext,
  key: MintedApiKey,
): APIRequestContext {
  // We don't actually wrap — Playwright's APIRequestContext is final. Specs
  // pass `headers: authHeaders(key)` per call. This signature exists so a
  // future refactor (e.g. context-level extraHTTPHeaders) has a single edit
  // point.
  void key;
  return request;
}
