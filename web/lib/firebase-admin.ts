/**
 * Firebase Admin SDK — server-only. Importing this from client code would ship the service
 * account. Requires FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY
 * (private key carries literal \n escape sequences).
 *
 * Modular entrypoints (`firebase-admin/app`, `/auth`, `/firestore`, `/storage`) rather than
 * the `admin.*` namespace: v14 dropped the legacy namespace entirely.
 */

import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage, type Storage } from 'firebase-admin/storage';

/** Singleton init; credentials come from env. */
if (!getApps().length) {
  try {
    // Emulator mode (Playwright E2E). The Admin SDK auto-routes to the emulator on the
    // *_EMULATOR_HOST vars ONLY if initializeApp gets no cert credential — a cert forces the
    // real-auth flow even while verifyIdToken honours the env var, giving "verify hits the
    // emulator, writes hit prod".
    const isEmulatorMode =
      !!process.env.FIREBASE_AUTH_EMULATOR_HOST ||
      !!process.env.FIRESTORE_EMULATOR_HOST;

    if (isEmulatorMode) {
      const projectId = process.env.FIREBASE_PROJECT_ID || 'demo-playwright-e2e';
      initializeApp({
        projectId,
        storageBucket: `${projectId}.firebasestorage.app`,
      });
      console.log(`Firebase Admin SDK initialized in emulator mode (project: ${projectId})`);
    } else {
      const projectId = process.env.FIREBASE_PROJECT_ID;
      const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
      const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

      if (!projectId || !clientEmail || !privateKey) {
        console.error('Firebase Admin SDK: Missing required environment variables');
        console.error('Required: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY');
        // Deliberately not throwing: the app boots, admin features stay dead.
      } else {
        initializeApp({
          credential: cert({
            projectId,
            clientEmail,
            privateKey,
          }),
          storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || `${projectId}.firebasestorage.app`,
        });

        console.log('Firebase Admin SDK initialized successfully');
      }
    }
  } catch (error) {
    console.error('Failed to initialize Firebase Admin SDK:', error);
    // Deliberately not throwing: the app boots, admin features stay dead.
  }
}

// Lazy getters: resolved at runtime, not module load, so a Next build without env vars
// doesn't fail.

let _adminAuth: Auth | null = null;
let _adminDb: Firestore | null = null;
let _adminStorage: Storage | null = null;

export const adminAuth = {
  get value() {
    if (!_adminAuth && getApps().length) {
      _adminAuth = getAuth();
    }
    if (!_adminAuth) {
      throw new Error('Firebase Admin SDK not initialized. Check environment variables.');
    }
    return _adminAuth;
  }
};

export const adminDb = {
  get value() {
    if (!_adminDb && getApps().length) {
      _adminDb = getFirestore();
    }
    if (!_adminDb) {
      throw new Error('Firebase Admin SDK not initialized. Check environment variables.');
    }
    return _adminDb;
  }
};

export const adminStorage = {
  get value() {
    if (!_adminStorage && getApps().length) {
      _adminStorage = getStorage();
    }
    if (!_adminStorage) {
      throw new Error('Firebase Admin SDK not initialized. Check environment variables.');
    }
    return _adminStorage;
  }
};

export const getAdminAuth = () => adminAuth.value;
export const getAdminDb = () => adminDb.value;
export const getAdminStorage = () => adminStorage.value;
