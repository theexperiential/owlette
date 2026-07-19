/**
 * Server-Side Device Trust ("remember this device for 30 days")
 *
 * When a user clears an MFA challenge and opts to trust the device, we mint a
 * 256-bit opaque token. The RAW token is returned to the browser in a single
 * HTTPOnly cookie (`owlette_device_trust`) and is NEVER persisted anywhere on
 * the server. Only its SHA-256 hash is stored, as the document id of a record
 * at `users/{uid}/trustedDevices/{tokenHash}`. On subsequent session creation,
 * `createSession()` reads the cookie, hashes it, and looks the hash up under
 * the freshly-verified uid — a hit that is present and unexpired lets the
 * session be born `mfaVerified: true` without re-challenging.
 *
 * TRUST MODEL:
 * - The raw token lives only in the HTTPOnly cookie; the server keeps only the
 *   hash. A database read alone therefore cannot reconstruct a usable token.
 * - The token is high-entropy random (256 bits), so a plain SHA-256 hash is
 *   sufficient — there is no low-entropy secret to protect. This is the same
 *   posture as API keys (see `apiAuth.server.ts` `hashApiKey`). We deliberately
 *   do NOT AES-encrypt it; encryption is reserved for the low-entropy TOTP
 *   secret (`encryption.server.ts`) and adds nothing here.
 * - Records are scoped per user, so a token only ever grants trust for the uid
 *   it was minted under; a different user on the same browser is still
 *   challenged.
 *
 * FAILURE POSTURE:
 * - The lookup read (`findValidTrustedDevice`) lets genuine Firestore errors
 *   PROPAGATE. The caller (`createSession`) catches them and treats the device
 *   as untrusted — a challenge is issued (fail-closed). Never fail open.
 *
 * All timestamps are stored as plain Unix-ms numbers (matching the `mfa_pending`
 * / prior device-trust conventions), never Firestore Timestamps.
 */

import crypto from 'crypto';
import { getAdminDb } from '@/lib/firebase-admin';

/** Cookie carrying the raw device-trust token (HTTPOnly, server-read only). */
export const DEVICE_TRUST_COOKIE = 'owlette_device_trust';

/** How long a trusted device stays trusted: 30 days, in milliseconds. */
export const DEVICE_TRUST_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

/** Subcollection under each user holding hashed trusted-device records. */
const TRUSTED_DEVICES_SUBCOLLECTION = 'trustedDevices';

/**
 * Max delete ops committed per Firestore batch. Firestore rejects more than 500
 * writes in a single batch, so any unbounded delete is chunked; 100 matches the
 * repo-wide cascade convention (see `deleteOwnAccount.server.ts` `BATCH_SIZE`).
 */
const DELETE_BATCH_SIZE = 100;

/**
 * Shape of a stored trusted-device record. All timestamps are Unix-ms numbers.
 * The document id is the token hash; `tokenHash` is duplicated in the body so a
 * future management UI can read the record without re-deriving it from the id.
 */
interface TrustedDeviceData {
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  userAgent: string;
  lastUsedAt: number;
}

/**
 * Mint a fresh device-trust token.
 *
 * @returns `raw` — the opaque token to set in the HTTPOnly cookie (never
 * stored); `hash` — the SHA-256 hex digest to persist as the record id.
 */
export function mintDeviceTrustToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString('base64url');
  return { raw, hash: hashDeviceTrustToken(raw) };
}

/** SHA-256 hex digest of a raw device-trust token (deterministic, unsalted). */
export function hashDeviceTrustToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * True when `data` has the minimum shape of a trusted-device record (a numeric
 * `expiresAt`) AND has not yet expired relative to `now`. Used to reject
 * missing / malformed / stale records before granting trust.
 */
export function isTrustRecordValid(data: unknown, now: number): boolean {
  return hasTrustRecordShape(data) && data.expiresAt > now;
}

/**
 * Cookie attributes for the device-trust cookie. Mirrors the session cookie
 * posture (`sessionManager.server.ts`): HTTPOnly, Secure only in production,
 * SameSite=lax, path=/. `maxAge` is in SECONDS (Set-Cookie semantics), so it is
 * the 30-day duration divided by 1000.
 */
export function deviceTrustCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: DEVICE_TRUST_DURATION_MS / 1000,
  };
}

/**
 * Persist a trusted-device record at `users/{userId}/trustedDevices/{tokenHash}`
 * and best-effort prune this user's expired records.
 *
 * The record write is authoritative — any failure PROPAGATES to the caller so a
 * failed mint is never silently swallowed. Pruning is best-effort: there is no
 * TTL janitor in this repo, so mint-time pruning keeps the subcollection
 * bounded, but a prune failure must never fail an otherwise-successful mint.
 */
export async function createTrustedDevice(
  userId: string,
  tokenHash: string,
  userAgent: string,
  now: number
): Promise<void> {
  const collection = trustedDevicesCollection(userId);

  const record: TrustedDeviceData = {
    tokenHash,
    createdAt: now,
    expiresAt: now + DEVICE_TRUST_DURATION_MS,
    userAgent,
    lastUsedAt: now,
  };

  // Authoritative write — propagate on failure.
  await collection.doc(tokenHash).set(record);

  // Best-effort prune of this user's expired records. Never fail the mint.
  try {
    const expired = await collection.where('expiresAt', '<', now).get();
    if (!expired.empty) {
      await deleteRefsInChunks(expired.docs.map((doc) => doc.ref));
    }
  } catch (err) {
    console.error(
      '[deviceTrust] failed to prune expired trusted devices for',
      userId,
      err
    );
  }
}

/**
 * Look up the raw cookie token under `userId` and report whether it grants
 * trust.
 *
 * - Missing document or malformed data → `false`.
 * - Well-formed but expired → fire-and-forget delete of the record, `false`.
 * - Valid → fire-and-forget `lastUsedAt` bump, `true`.
 *
 * Genuine Firestore errors on the `.get()` PROPAGATE: the caller treats a throw
 * as untrusted and issues a challenge (fail-closed). Fire-and-forget writes are
 * never awaited; each carries a `.catch()` so a write failure can never surface
 * as an unhandled rejection or flip a correct "untrusted" answer into a throw.
 */
export async function findValidTrustedDevice(
  userId: string,
  rawToken: string,
  now: number
): Promise<boolean> {
  const hash = hashDeviceTrustToken(rawToken);
  const ref = trustedDevicesCollection(userId).doc(hash);

  // A genuine failure of this read must propagate (fail-closed at the caller).
  const snap = await ref.get();
  if (!snap.exists) {
    return false;
  }

  const data = snap.data();
  if (isTrustRecordValid(data, now)) {
    // Valid: bump recency so a future management UI can show last-used. The
    // trust decision does not depend on this write — fire and forget.
    ref.update({ lastUsedAt: now }).catch((err) => {
      console.error(
        '[deviceTrust] failed to bump lastUsedAt for',
        userId,
        err
      );
    });
    return true;
  }

  // Not valid. Reap a well-formed record whose expiry has genuinely passed;
  // leave malformed records untouched. Fire-and-forget so a delete failure
  // cannot turn a correct "untrusted" result into a throw.
  if (hasTrustRecordShape(data)) {
    ref.delete().catch((err) => {
      console.error(
        '[deviceTrust] failed to delete expired trusted device for',
        userId,
        err
      );
    });
  }
  return false;
}

/**
 * Delete every trusted-device record for a user (e.g. on MFA disable or account
 * deletion). Deletes are chunked into batches of `DELETE_BATCH_SIZE`. Returns
 * the number of records removed.
 */
export async function revokeAllTrustedDevices(userId: string): Promise<number> {
  const snap = await trustedDevicesCollection(userId).get();
  if (snap.empty) {
    return 0;
  }
  return deleteRefsInChunks(snap.docs.map((doc) => doc.ref));
}

/** Single source of truth for the per-user trusted-devices subcollection ref. */
function trustedDevicesCollection(userId: string) {
  return getAdminDb()
    .collection('users')
    .doc(userId)
    .collection(TRUSTED_DEVICES_SUBCOLLECTION);
}

/**
 * Delete the given document refs in sequential batches of at most
 * `DELETE_BATCH_SIZE` ops (Firestore caps a batch at 500 writes, so an
 * unbounded set must be chunked). Commits run one after another; returns the
 * number of refs deleted.
 */
async function deleteRefsInChunks(
  refs: FirebaseFirestore.DocumentReference[]
): Promise<number> {
  const db = getAdminDb();
  for (let i = 0; i < refs.length; i += DELETE_BATCH_SIZE) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + DELETE_BATCH_SIZE)) {
      batch.delete(ref);
    }
    await batch.commit();
  }
  return refs.length;
}

/** Narrow `data` to the minimum record shape: an object with a numeric `expiresAt`. */
function hasTrustRecordShape(data: unknown): data is { expiresAt: number } {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { expiresAt?: unknown }).expiresAt === 'number'
  );
}
