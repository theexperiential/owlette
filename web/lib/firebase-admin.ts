/**
 * Firebase Admin SDK Configuration
 *
 * This is the server-side Firebase Admin SDK configuration for token generation
 * and other privileged operations. NEVER exposed to client-side code.
 *
 * SECURITY: This file should ONLY be imported in API routes (server-side).
 * The service account credentials are stored as environment variables and
 * are never sent to the client.
 *
 * Environment variables required:
 * - FIREBASE_PROJECT_ID: Firebase project ID
 * - FIREBASE_CLIENT_EMAIL: Service account email
 * - FIREBASE_PRIVATE_KEY: Service account private key (with \n escape sequences)
 */

import admin from 'firebase-admin';

/**
 * Initialize Firebase Admin SDK (singleton pattern)
 *
 * The Admin SDK provides elevated privileges for:
 * - Creating custom tokens for agent authentication
 * - Server-side Firestore operations
 * - User management
 *
 * Credentials are pulled from environment variables to avoid hardcoding secrets.
 */
if (!admin.apps.length) {
  try {
    // Parse service account credentials from environment variables
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

    // Validate required credentials
    if (!projectId || !clientEmail || !privateKey) {
      console.error('Firebase Admin SDK: Missing required environment variables');
      console.error('Required: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY');
      // Don't throw - allow app to start but admin features won't work
    } else {
      // Initialize Admin SDK
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey,
        }),
        storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || `${projectId}.firebasestorage.app`,
      });

      console.log('Firebase Admin SDK initialized successfully');
    }
  } catch (error) {
    console.error('Failed to initialize Firebase Admin SDK:', error);
    // Don't throw - allow app to start but admin features won't work
  }
}

// Export getter functions for Admin SDK services (lazy initialization)
// This prevents errors during Next.js build when env vars aren't available
// These are called at runtime, not during module load

let _adminAuth: admin.auth.Auth | null = null;
let _adminDb: admin.firestore.Firestore | null = null;
let _adminStorage: admin.storage.Storage | null = null;

export const adminAuth = {
  get value() {
    if (!_adminAuth && admin.apps.length) {
      _adminAuth = admin.auth();
    }
    if (!_adminAuth) {
      throw new Error('Firebase Admin SDK not initialized. Check environment variables.');
    }
    return _adminAuth;
  }
};

export const adminDb = {
  get value() {
    if (!_adminDb && admin.apps.length) {
      _adminDb = admin.firestore();
    }
    if (!_adminDb) {
      throw new Error('Firebase Admin SDK not initialized. Check environment variables.');
    }
    return _adminDb;
  }
};

export const adminStorage = {
  get value() {
    if (!_adminStorage && admin.apps.length) {
      _adminStorage = admin.storage();
    }
    if (!_adminStorage) {
      throw new Error('Firebase Admin SDK not initialized. Check environment variables.');
    }
    return _adminStorage;
  }
};

// Helper functions for easier access
export const getAdminAuth = () => adminAuth.value;
export const getAdminDb = () => adminDb.value;
export const getAdminStorage = () => adminStorage.value;

// Export admin instance for advanced use cases
export default admin;
