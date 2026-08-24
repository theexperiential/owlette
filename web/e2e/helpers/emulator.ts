/**
 * Emulator helpers — shared constants + Admin SDK init for E2E.
 *
 * Ports come from firebase.json. FIREBASE_AUTH_EMULATOR_HOST /
 * FIRESTORE_EMULATOR_HOST / FIREBASE_STORAGE_EMULATOR_HOST are set by
 * `firebase emulators:exec`; we rely on the Admin SDK auto-detecting them.
 */

import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

export const EMULATOR_PROJECT_ID = 'demo-playwright-e2e';

const AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const STORAGE_EMULATOR_HOST =
  process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199';

export const AUTH_EMULATOR_URL = `http://${AUTH_EMULATOR_HOST}`;
export const FIRESTORE_EMULATOR_URL = `http://${FIRESTORE_EMULATOR_HOST}`;
export const STORAGE_EMULATOR_URL = `http://${STORAGE_EMULATOR_HOST}`;

export const E2E_PORT = Number(process.env.E2E_PORT) || 3100;
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

/**
 * Initialize the Admin SDK in emulator mode. Idempotent — reuses the default
 * app. Requires the *_EMULATOR_HOST env vars, which `firebase emulators:exec`
 * sets around global-setup.
 */
export function getAdminApp(): App {
  const existing = getApps();
  if (existing.length > 0 && existing[0]) {
    return existing[0];
  }
  return initializeApp({
    projectId: EMULATOR_PROJECT_ID,
    storageBucket: `${EMULATOR_PROJECT_ID}.firebasestorage.app`,
  });
}

export function getAdminAuth(): Auth {
  return getAuth(getAdminApp());
}

export function getAdminDb(): Firestore {
  return getFirestore(getAdminApp());
}

/** Wipe Firestore via the emulator's REST endpoint (bypasses security rules). */
export async function clearFirestoreEmulator(): Promise<void> {
  const res = await fetch(
    `${FIRESTORE_EMULATOR_URL}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    throw new Error(`Failed to clear Firestore emulator: ${res.status} ${await res.text()}`);
  }
}

/** Wipe every Auth emulator user. */
export async function clearAuthEmulator(): Promise<void> {
  const res = await fetch(
    `${AUTH_EMULATOR_URL}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/accounts`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    throw new Error(`Failed to clear Auth emulator: ${res.status} ${await res.text()}`);
  }
}

/** Full reset, run by global-setup so a run can't inherit prior state. */
export async function resetEmulators(): Promise<void> {
  await Promise.all([clearFirestoreEmulator(), clearAuthEmulator()]);
}
