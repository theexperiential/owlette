/**
 * Emulator helpers — shared constants + Admin SDK init for E2E tests.
 *
 * All paths assume the emulators were started via firebase-tools with our
 * configured ports (firebase.json). Env vars FIREBASE_AUTH_EMULATOR_HOST /
 * FIRESTORE_EMULATOR_HOST / FIREBASE_STORAGE_EMULATOR_HOST are set by
 * `firebase emulators:exec` — we rely on the Admin SDK's auto-detection.
 */

import admin from 'firebase-admin';

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
 * Initialize the Admin SDK in emulator mode. Safe to call multiple times —
 * reuses the default app if it already exists.
 *
 * Requires FIREBASE_AUTH_EMULATOR_HOST / FIRESTORE_EMULATOR_HOST / etc. to be
 * set in process.env before this is called (they are, because global-setup
 * runs inside `firebase emulators:exec` which sets them automatically).
 */
export function getAdminApp(): admin.app.App {
  if (admin.apps.length > 0 && admin.apps[0]) {
    return admin.apps[0];
  }
  return admin.initializeApp({
    projectId: EMULATOR_PROJECT_ID,
    storageBucket: `${EMULATOR_PROJECT_ID}.firebasestorage.app`,
  });
}

export function getAdminAuth(): admin.auth.Auth {
  return getAdminApp().auth();
}

export function getAdminDb(): admin.firestore.Firestore {
  return getAdminApp().firestore();
}

/**
 * Clear every document in the Firestore emulator for a fresh test run.
 * Uses the emulator's special REST endpoint — bypasses security rules.
 */
export async function clearFirestoreEmulator(): Promise<void> {
  const res = await fetch(
    `${FIRESTORE_EMULATOR_URL}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    throw new Error(`Failed to clear Firestore emulator: ${res.status} ${await res.text()}`);
  }
}

/**
 * Clear every user in the Auth emulator for a fresh test run.
 */
export async function clearAuthEmulator(): Promise<void> {
  const res = await fetch(
    `${AUTH_EMULATOR_URL}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/accounts`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    throw new Error(`Failed to clear Auth emulator: ${res.status} ${await res.text()}`);
  }
}

/**
 * Full reset: clear all Auth users + all Firestore docs. Called by global-setup
 * at the start of every run so tests don't inherit state from a prior run.
 */
export async function resetEmulators(): Promise<void> {
  await Promise.all([clearFirestoreEmulator(), clearAuthEmulator()]);
}
