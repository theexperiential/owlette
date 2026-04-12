/**
 * Firebase Client Configuration
 *
 * This is the client-side Firebase configuration for the web portal.
 * Uses Firebase JS SDK (not Admin SDK like the Python agent).
 *
 * Environment variables are validated at app startup in layout.tsx (warnings only).
 */

import { initializeApp, getApps, FirebaseApp } from 'firebase/app';
import { getAuth, Auth } from 'firebase/auth';
import { getFirestore, Firestore } from 'firebase/firestore';
import { getStorage, FirebaseStorage } from 'firebase/storage';

// Firebase configuration
// These values come from Firebase Console > Project Settings > Web App
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || 'placeholder',
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || 'placeholder.firebaseapp.com',
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'placeholder',
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || 'placeholder.appspot.com',
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || '123456789',
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || 'placeholder',
};

// Check if Firebase is configured
const isConfigured = typeof window !== 'undefined' &&
                     process.env.NEXT_PUBLIC_FIREBASE_API_KEY &&
                     process.env.NEXT_PUBLIC_FIREBASE_API_KEY !== 'placeholder';

// Initialize Firebase (singleton pattern) - only on client side
let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;
let storage: FirebaseStorage | null = null;

if (typeof window !== 'undefined' && !getApps().length && isConfigured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  storage = getStorage(app);
} else if (typeof window !== 'undefined' && getApps().length) {
  app = getApps()[0];
  auth = getAuth(app);
  db = getFirestore(app);
  storage = getStorage(app);
}

export { app, auth, db, storage, isConfigured };

/**
 * Firebase Helper Functions
 */

import { getDoc, doc, setDoc, Timestamp } from 'firebase/firestore';

/**
 * Get the latest Owlette agent version from installer_metadata collection
 * @returns Latest version metadata or null if not found
 */
export async function getLatestOwletteVersion(): Promise<{
  version: string;
  downloadUrl: string;
  sha256Checksum?: string;
  releaseDate?: Date;
  releaseNotes?: string;
} | null> {
  if (!db) {
    throw new Error('Firestore not initialized');
  }

  try {
    // Get the latest version from the dedicated 'latest' document
    const latestRef = doc(db, 'installer_metadata', 'latest');
    const latestDoc = await getDoc(latestRef);

    if (!latestDoc.exists()) {
      console.warn('No latest Owlette version found in installer_metadata/latest');
      return null;
    }

    const data = latestDoc.data();

    return {
      version: data.version || 'Unknown',
      downloadUrl: data.download_url || data.downloadUrl || data.url || '',
      sha256Checksum: data.checksum_sha256 || data.sha256Checksum || data.checksum,
      releaseDate: data.release_date?.toDate?.() || data.releaseDate?.toDate?.() || data.uploadedAt?.toDate?.(),
      releaseNotes: data.release_notes || data.releaseNotes || data.changelog,
    };
  } catch (error) {
    console.error('Error fetching latest Owlette version:', error);
    throw error;
  }
}

/**
 * Send update_owlette command to a machine
 *
 * ANTI-FRAGILE: Requires checksum (agent will reject commands without it).
 * Always fetches a fresh download URL from installer_metadata to avoid expired tokens.
 *
 * @param siteId Site ID
 * @param machineId Machine ID
 * @param installerUrl URL of the Owlette installer
 * @param deploymentId Optional deployment ID for tracking
 * @param targetVersion Target version string (e.g., "2.1.0")
 * @param checksumSha256 SHA256 checksum of the installer (REQUIRED - agent rejects without it)
 * @returns Command ID
 */
export async function sendOwletteUpdateCommand(
  siteId: string,
  machineId: string,
  installerUrl: string,
  deploymentId?: string,
  targetVersion?: string,
  checksumSha256?: string
): Promise<string> {
  if (!db) {
    throw new Error('Firestore not initialized');
  }

  // ANTI-FRAGILE: Checksum is mandatory - agent will reject updates without it
  if (!checksumSha256) {
    throw new Error('Checksum is required for self-updates. The agent will reject updates without SHA256 verification.');
  }

  // ANTI-FRAGILE: Version is mandatory for proper update tracking
  if (!targetVersion) {
    throw new Error('Target version is required for update tracking.');
  }

  try {
    // ANTI-FRAGILE: Fetch a fresh download URL from installer_metadata to avoid
    // expired Firebase Storage tokens. URLs contain auth tokens that expire after ~7 days.
    // If the machine is offline and processes this command later, the original URL may be stale.
    let freshUrl = installerUrl;
    try {
      const latestRef = doc(db, 'installer_metadata', 'latest');
      const latestDoc = await getDoc(latestRef);
      if (latestDoc.exists()) {
        const data = latestDoc.data();
        const metadataUrl = data.download_url || data.downloadUrl || data.url;
        if (metadataUrl) {
          freshUrl = metadataUrl;
        }
      }
    } catch (urlErr) {
      console.warn('Could not refresh download URL, using provided URL:', urlErr);
    }

    const commandId = `update_owlette_${Date.now()}`;
    const commandRef = doc(
      db,
      'sites', siteId,
      'machines', machineId,
      'commands', 'pending'
    );

    await setDoc(commandRef, {
      [commandId]: {
        type: 'update_owlette',
        installer_url: freshUrl,
        deployment_id: deploymentId || null,
        target_version: targetVersion,
        checksum_sha256: checksumSha256,
        timestamp: Timestamp.now(),
        status: 'pending',
      }
    }, { merge: true });

    console.log(`Sent update_owlette command to ${machineId}:`, commandId);
    return commandId;
  } catch (error) {
    console.error('Error sending update_owlette command:', error);
    throw error;
  }
}
