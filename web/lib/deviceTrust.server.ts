/**
 * Server-side device trust ("remember this device for 30 days").
 *
 * Clearing an MFA challenge with "trust this device" mints a 256-bit opaque
 * token. The RAW token goes only into the HTTPOnly `owlette_device_trust`
 * cookie and is never persisted; the server stores only its SHA-256 hash, as
 * the doc id at `users/{uid}/trustedDevices/{tokenHash}`. `createSession()`
 * hashes the cookie, looks it up under the freshly-verified uid, and on an
 * unexpired hit is born `mfaVerified: true`.
 *
 * Plain SHA-256 is deliberate: the token is 256-bit random, so there is no
 * low-entropy secret to protect (same posture as `apiAuth.server.ts`
 * `hashApiKey`). Do NOT AES-encrypt — that's reserved for the TOTP secret.
 * Records are per-uid, so a token never grants trust to another user on the
 * same browser.
 *
 * Fail-closed: `findValidTrustedDevice` lets Firestore errors PROPAGATE, and
 * `createSession` treats a throw as untrusted. Never fail open.
 *
 * Timestamps are plain Unix-ms numbers, never Firestore Timestamps.
 */

import crypto from 'crypto';
import { getAdminDb } from '@/lib/firebase-admin';

/** Raw device-trust token cookie (HTTPOnly, server-read only). */
export const DEVICE_TRUST_COOKIE = 'owlette_device_trust';

/** Trust duration, ms. */
export const DEVICE_TRUST_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

const TRUSTED_DEVICES_SUBCOLLECTION = 'trustedDevices';

/** Deletes per batch. Firestore caps a batch at 500; 100 matches the repo-wide
 * cascade convention (`deleteOwnAccount.server.ts` `BATCH_SIZE`). */
const DELETE_BATCH_SIZE = 100;

/**
 * Stored trusted-device record; timestamps are Unix-ms. The doc id is the token
 * hash, duplicated into the body so a management UI needn't re-derive it.
 */
interface TrustedDeviceData {
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  userAgent: string;
  lastUsedAt: number;
}

/** Mint a token: `raw` goes in the cookie only, `hash` is the persisted doc id. */
export function mintDeviceTrustToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString('base64url');
  return { raw, hash: hashDeviceTrustToken(raw) };
}

/** SHA-256 hex digest of a raw device-trust token (deterministic, unsalted). */
export function hashDeviceTrustToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Record is well-shaped (numeric `expiresAt`) and unexpired at `now`. */
export function isTrustRecordValid(data: unknown, now: number): boolean {
  return hasTrustRecordShape(data) && data.expiresAt > now;
}

/**
 * Mirrors the session cookie posture (`sessionManager.server.ts`). `maxAge` is
 * in SECONDS per Set-Cookie semantics — hence the /1000.
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
 * Persist a trusted-device record and best-effort prune this user's expired ones.
 *
 * The write is authoritative and PROPAGATES on failure. Pruning is best-effort:
 * there's no TTL janitor here, so mint-time pruning bounds the subcollection —
 * but a prune failure must never fail an otherwise-successful mint.
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

  // Authoritative — propagate on failure.
  await collection.doc(tokenHash).set(record);

  // Best-effort prune; never fail the mint.
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
 * Does the raw cookie token grant trust for `userId`?
 *
 * Missing/malformed → false. Expired → false + fire-and-forget delete. Valid →
 * true + fire-and-forget `lastUsedAt` bump.
 *
 * Errors from `.get()` PROPAGATE (caller fails closed). The fire-and-forget
 * writes each carry a `.catch()` so a write failure can't become an unhandled
 * rejection or turn a correct "untrusted" into a throw.
 */
export async function findValidTrustedDevice(
  userId: string,
  rawToken: string,
  now: number
): Promise<boolean> {
  const hash = hashDeviceTrustToken(rawToken);
  const ref = trustedDevicesCollection(userId).doc(hash);

  const snap = await ref.get();
  if (!snap.exists) {
    return false;
  }

  const data = snap.data();
  if (isTrustRecordValid(data, now)) {
    // Recency only — the trust decision doesn't depend on it, so fire and forget.
    ref.update({ lastUsedAt: now }).catch((err) => {
      console.error(
        '[deviceTrust] failed to bump lastUsedAt for',
        userId,
        err
      );
    });
    return true;
  }

  // Reap a genuinely-expired record; leave malformed ones alone. Fire-and-forget
  // so a delete failure can't turn a correct "untrusted" into a throw.
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

/** Delete every trusted-device record for a user (MFA disable, account deletion). */
export async function revokeAllTrustedDevices(userId: string): Promise<number> {
  const snap = await trustedDevicesCollection(userId).get();
  if (snap.empty) {
    return 0;
  }
  return deleteRefsInChunks(snap.docs.map((doc) => doc.ref));
}

function trustedDevicesCollection(userId: string) {
  return getAdminDb()
    .collection('users')
    .doc(userId)
    .collection(TRUSTED_DEVICES_SUBCOLLECTION);
}

/** Delete refs in sequential `DELETE_BATCH_SIZE` batches (Firestore caps at 500). */
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

/** Narrow to the minimum record shape: object with numeric `expiresAt`. */
function hasTrustRecordShape(data: unknown): data is { expiresAt: number } {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { expiresAt?: unknown }).expiresAt === 'number'
  );
}
