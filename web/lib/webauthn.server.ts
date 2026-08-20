/**
 * WebAuthn (Passkey) Server Configuration & Firestore Helpers
 *
 * Centralized configuration for WebAuthn registration and authentication.
 * Handles challenge storage, credential persistence, and RP configuration.
 *
 * IMPORTANT: This file should only be imported in server components/API routes.
 */

import { getAdminDb } from '@/lib/firebase-admin';
import type { AuthenticatorTransportFuture } from '@simplewebauthn/server';

// ── RP (Relying Party) Configuration ────────────────────────────────────

const RP_NAME = 'Owlette';

/**
 * E2E override for the relying-party identity.
 *
 * This is checked BEFORE the production branch on purpose — do not "simplify"
 * it down to the dev fall-through. The Playwright harness serves a PRODUCTION
 * Next build (`web/scripts/e2e-next-server.mjs` calls `next({ dev: false })`,
 * and Next inlines NODE_ENV at build time), so without this override
 * `getRpId()` resolves to 'owlette.app' and the origins to the https pair, and
 * no ceremony run against the loopback e2e server could ever verify.
 *
 * Gated on OWLETTE_E2E === '1', which only `web/playwright.config.ts` sets, and
 * only honored when a value is actually supplied — an e2e run that forgets to
 * thread the vars falls through to the normal branches rather than silently
 * running with an empty origin allowlist.
 */
function e2eRpOverride(name: 'WEBAUTHN_RP_ID' | 'WEBAUTHN_ORIGINS'): string | null {
  if (process.env.OWLETTE_E2E !== '1') {
    return null;
  }
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function getRpId(): string {
  const e2eRpId = e2eRpOverride('WEBAUTHN_RP_ID');
  if (e2eRpId) {
    return e2eRpId;
  }
  if (process.env.NODE_ENV === 'production') {
    return 'owlette.app';
  }
  return 'localhost';
}

export function getExpectedOrigins(): string[] {
  // Comma-separated so a spec can allow more than one loopback origin.
  const e2eOrigins = e2eRpOverride('WEBAUTHN_ORIGINS')
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (e2eOrigins && e2eOrigins.length > 0) {
    return e2eOrigins;
  }
  if (process.env.NODE_ENV === 'production') {
    return ['https://owlette.app', 'https://dev.owlette.app'];
  }
  return ['http://localhost:3000'];
}

export function getRpName(): string {
  return RP_NAME;
}

// ── Types ───────────────────────────────────────────────────────────────

export interface StoredPasskey {
  credentialId: string;
  credentialPublicKey: string; // base64url-encoded
  counter: number;
  transports?: AuthenticatorTransportFuture[];
  deviceType: string;
  backedUp: boolean;
  friendlyName: string;
  createdAt: Date;
  lastUsedAt: Date;
}

export interface PasskeyInfo {
  credentialId: string;
  friendlyName: string;
  deviceType: string;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string;
}

interface StoredChallenge {
  challenge: string;
  userId: string | null;
  type: 'registration' | 'authentication';
  createdAt: Date;
  expiresAt: Date;
}

// ── Challenge Management ────────────────────────────────────────────────

const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export async function storeChallenge(
  challengeId: string,
  challenge: string,
  userId: string | null,
  type: 'registration' | 'authentication'
): Promise<void> {
  const db = getAdminDb();
  await db.collection('webauthn_challenges').doc(challengeId).set({
    challenge,
    userId,
    type,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  });
}

export async function getAndDeleteChallenge(
  challengeId: string
): Promise<StoredChallenge | null> {
  const db = getAdminDb();
  const docRef = db.collection('webauthn_challenges').doc(challengeId);
  const doc = await docRef.get();

  if (!doc.exists) {
    return null;
  }

  const data = doc.data() as StoredChallenge;

  // Delete challenge (single-use)
  await docRef.delete();

  // Check expiry
  const expiresAt = data.expiresAt instanceof Date
    ? data.expiresAt
    : new Date((data.expiresAt as { _seconds: number })._seconds * 1000);

  if (Date.now() > expiresAt.getTime()) {
    return null;
  }

  return data;
}

// ── Passkey CRUD ────────────────────────────────────────────────────────

export async function getUserPasskeys(userId: string): Promise<StoredPasskey[]> {
  const db = getAdminDb();
  const snapshot = await db
    .collection('users')
    .doc(userId)
    .collection('passkeys')
    .get();

  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      credentialId: doc.id,
      credentialPublicKey: data.credentialPublicKey,
      counter: data.counter,
      transports: data.transports,
      deviceType: data.deviceType,
      backedUp: data.backedUp,
      friendlyName: data.friendlyName,
      createdAt: data.createdAt?.toDate?.() ?? new Date(data.createdAt),
      lastUsedAt: data.lastUsedAt?.toDate?.() ?? new Date(data.lastUsedAt),
    };
  });
}

export async function storePasskey(
  userId: string,
  credential: {
    credentialId: string;
    credentialPublicKey: string;
    counter: number;
    transports?: AuthenticatorTransportFuture[];
    deviceType: string;
    backedUp: boolean;
  },
  friendlyName: string
): Promise<void> {
  const db = getAdminDb();
  const batch = db.batch();

  // Store credential in passkeys subcollection
  const passkeyRef = db
    .collection('users')
    .doc(userId)
    .collection('passkeys')
    .doc(credential.credentialId);

  batch.set(passkeyRef, {
    credentialPublicKey: credential.credentialPublicKey,
    counter: credential.counter,
    transports: credential.transports ?? [],
    deviceType: credential.deviceType,
    backedUp: credential.backedUp,
    friendlyName,
    createdAt: new Date(),
    lastUsedAt: new Date(),
  });

  // Set passkeyEnrolled flag on user document
  const userRef = db.collection('users').doc(userId);
  batch.update(userRef, { passkeyEnrolled: true });

  await batch.commit();
}

export async function deletePasskey(
  userId: string,
  credentialId: string
): Promise<void> {
  const db = getAdminDb();

  // Delete the passkey document
  await db
    .collection('users')
    .doc(userId)
    .collection('passkeys')
    .doc(credentialId)
    .delete();

  // Check if any passkeys remain
  const remaining = await db
    .collection('users')
    .doc(userId)
    .collection('passkeys')
    .limit(1)
    .get();

  if (remaining.empty) {
    await db.collection('users').doc(userId).update({ passkeyEnrolled: false });
  }
}

export async function updatePasskeyCounter(
  userId: string,
  credentialId: string,
  newCounter: number
): Promise<void> {
  const db = getAdminDb();
  await db
    .collection('users')
    .doc(userId)
    .collection('passkeys')
    .doc(credentialId)
    .update({
      counter: newCounter,
      lastUsedAt: new Date(),
    });
}

export async function renamePasskey(
  userId: string,
  credentialId: string,
  friendlyName: string
): Promise<void> {
  const db = getAdminDb();
  await db
    .collection('users')
    .doc(userId)
    .collection('passkeys')
    .doc(credentialId)
    .update({ friendlyName });
}

export async function getPasskeyListInfo(userId: string): Promise<PasskeyInfo[]> {
  const passkeys = await getUserPasskeys(userId);
  return passkeys.map((p) => ({
    credentialId: p.credentialId,
    friendlyName: p.friendlyName,
    deviceType: p.deviceType,
    backedUp: p.backedUp,
    createdAt: p.createdAt.toISOString(),
    lastUsedAt: p.lastUsedAt.toISOString(),
  }));
}
