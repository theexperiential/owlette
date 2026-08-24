/**
 * API key minting for e2e specs that hit the public scoped API through
 * `APIRequestContext` rather than a browser.
 *
 * Writes `users/{uid}/api_keys/{keyId}` + the `api_keys/{keyHash}` lookup
 * directly via the Admin SDK — the same shape `POST /api/keys` produces —
 * bypassing that endpoint's session-cookie requirement.
 *
 * Owner uid defaults to `super-uid`: the `installer` and `user` resources are
 * superadmin-only to mint (`SUPERADMIN_ONLY_RESOURCES`). Other resources can
 * pass `admin-uid`.
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

/** Mint a scoped api key into the emulator. Returns the raw `owk_*` string for
 * `Authorization: Bearer ...` plus the keyId for cleanup. */
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

/** Delete both docs. Idempotent — delete() on a missing doc is a no-op. */
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

/** Bearer header + a fresh `Idempotency-Key`. `idempotencyKey: false` drops the
 * latter (e.g. for GETs). */
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

/** authHeaders() with an always-fresh uuid Idempotency-Key. */
export function freshHeaders(key: MintedApiKey): Record<string, string> {
  return authHeaders(key, crypto.randomUUID());
}

/**
 * Threads the api-key through APIRequestContext without re-creating headers.
 * Each call spawns a fresh `Idempotency-Key`, so replay tests must pass their
 * own header instead.
 */
export function bindRequest(
  request: APIRequestContext,
  key: MintedApiKey,
): APIRequestContext {
  // No real wrapping: APIRequestContext is final, so specs pass
  // `headers: authHeaders(key)` per call. This signature is the single edit
  // point for a future context-level `extraHTTPHeaders` refactor.
  void key;
  return request;
}
