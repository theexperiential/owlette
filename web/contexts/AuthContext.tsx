'use client';

import { createContext, useContext, useEffect, useState, useMemo } from 'react';
import {
  User,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  updateProfile,
  updatePassword as firebaseUpdatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
  deleteUser,
} from 'firebase/auth';
import { doc, getDoc, setDoc, onSnapshot, collection, getDocs, writeBatch } from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import { auth, db, storage } from '@/lib/firebase';
import { handleError } from '@/lib/errorHandler';
import { getBrowserTimezone } from '@/lib/timeUtils';
import { toast } from 'sonner';
import { clearMfaSession } from '@/lib/mfaSession';
import * as Sentry from '@sentry/nextjs';

// Shallow-compare two arrays by value (for string arrays like userSites)
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Shallow-compare two flat objects (for lastMachineIds)
function shallowEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

// Helper functions for server-side session management
const createSessionCookie = async (userId: string, idToken: string): Promise<void> => {
  try {
    const response = await fetch('/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, idToken }),
    });

    if (!response.ok) {
      console.error('[Session] Failed to create session:', await response.text());
    }
  } catch (error) {
    console.error('[Session] Failed to create session:', error);
  }
};

const destroySessionCookie = async (): Promise<void> => {
  try {
    const response = await fetch('/api/auth/session', {
      method: 'DELETE',
    });

    if (!response.ok) {
      console.error('[Session] Failed to destroy session:', await response.text());
    }
  } catch (error) {
    console.error('[Session] Failed to destroy session:', error);
  }
};

type UserRole = 'user' | 'admin';

export interface UserPreferences {
  temperatureUnit: 'C' | 'F'; // Default: 'C'
  timezone: string; // IANA timezone (e.g. 'America/New_York'). Default: browser-detected. Used as the display reference frame when timeDisplayMode === 'user'.
  timeFormat: '12h' | '24h'; // Time display format. Default: '12h'
  /** Which timezone reference frame to use when rendering absolute timestamps
   * (heartbeats, activity logs, etc) on the dashboard:
   *   - 'user'    → render in `timezone` above (single reference frame for all machines)
   *   - 'machine' → render each machine's timestamps in that machine's own local timezone (best for distributed kiosks)
   *   - 'site'    → render in the site's configured timezone (legacy/single-team behavior)
   * Schedule editors are unaffected — they always use the machine's local timezone with an explicit chip label.
   * Default: 'machine'. */
  timeDisplayMode: 'user' | 'machine' | 'site';
  healthAlerts: boolean; // Receive email alerts when machines go offline. Default: true
  processAlerts: boolean; // Receive email alerts when processes crash or fail to start. Default: true
  thresholdAlerts: boolean; // Receive email alerts when health metrics exceed thresholds. Default: true
  cortexAlerts: boolean; // Receive email alerts when Cortex AI escalates unresolved issues. Default: true
  mutedMachines: string[]; // Machine IDs to suppress all alerts for. Default: []
  alertCcEmails: string[]; // Additional CC recipients for alert emails. Default: []
  statsExpanded: boolean; // Whether stats section is expanded in card view. Default: false
  processesExpanded: boolean; // Whether process list is expanded in card view. Default: false
  /** Remembered graph tab selection for each machine's MetricsDetailPanel.
   * Keyed by machineId → array of namespaced tab ids (e.g. 'metric:cpu', 'nic:Ethernet 2', 'gpu:0').
   * Unknown namespaces are ignored on read, so new entity types slot in without migration. */
  graphTabs?: Record<string, string[]>;
  /** Which machine's MetricsDetailPanel is currently open, and the metric that opened it.
   * Null/absent when no panel is open. Persisted so the panel reappears after reload. */
  activeGraphPanel?: { machineId: string; metric: string } | null;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  role: UserRole;
  isAdmin: boolean;
  userSites: string[]; // Sites the user has access to
  lastSiteId: string | null; // Last active site (synced to Firestore)
  lastMachineIds: Record<string, string>; // Last active machine per site (synced to Firestore)
  requiresMfaSetup: boolean; // Whether user needs to complete 2FA setup
  passkeyEnrolled: boolean; // Whether user has registered passkeys
  userPreferences: UserPreferences; // User preferences (temperature unit, etc.)
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, firstName?: string, lastName?: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  updateUserProfile: (firstName: string, lastName: string) => Promise<void>;
  updateUserPhoto: (photoBlob: Blob | null) => Promise<void>;
  updatePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  updateUserPreferences: (preferences: Partial<UserPreferences>, options?: { silent?: boolean }) => Promise<void>;
  updateLastSite: (siteId: string) => void;
  updateLastMachine: (siteId: string, machineId: string) => void;
  deleteAccount: (password: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  role: 'user',
  isAdmin: false,
  userSites: [],
  lastSiteId: null,
  lastMachineIds: {},
  requiresMfaSetup: false,
  passkeyEnrolled: false,
  userPreferences: { temperatureUnit: 'C', timezone: 'UTC', timeFormat: '12h', timeDisplayMode: 'machine', healthAlerts: true, processAlerts: true, thresholdAlerts: true, cortexAlerts: true, mutedMachines: [], alertCcEmails: [], statsExpanded: true, processesExpanded: true },
  signIn: async () => {},
  signUp: async () => {},
  signInWithGoogle: async () => {},
  signOut: async () => {},
  updateUserProfile: async () => {},
  updateUserPhoto: async () => {},
  updatePassword: async () => {},
  updateUserPreferences: async () => {},
  updateLastSite: () => {},
  updateLastMachine: () => {},
  deleteAccount: async () => {},
});

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<UserRole>('user');
  const [userSites, setUserSites] = useState<string[]>([]);
  const [requiresMfaSetup, setRequiresMfaSetup] = useState(false);
  const [passkeyEnrolled, setPasskeyEnrolled] = useState(false);
  const [userPreferences, setUserPreferences] = useState<UserPreferences>({ temperatureUnit: 'C', timezone: getBrowserTimezone(), timeFormat: '12h', timeDisplayMode: 'machine', healthAlerts: true, processAlerts: true, thresholdAlerts: true, cortexAlerts: true, mutedMachines: [], alertCcEmails: [], statsExpanded: true, processesExpanded: true });
  const [lastSiteId, setLastSiteId] = useState<string | null>(null);
  const [lastMachineIds, setLastMachineIds] = useState<Record<string, string>>({});

  // Helper function to send user creation notification
  const sendUserCreatedNotification = async (
    email: string,
    displayName: string,
    authMethod: 'email' | 'google'
  ) => {
    try {
      let idToken: string | null = null;
      if (auth?.currentUser) {
        try {
          idToken = await auth.currentUser.getIdToken();
        } catch (tokenError) {
          console.warn('Failed to get ID token for notification:', tokenError);
        }
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (idToken) {
        headers.Authorization = `Bearer ${idToken}`;
      }

      const response = await fetch('/api/webhooks/user-created', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          email,
          displayName,
          authMethod,
          createdAt: new Date().toISOString(),
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ status: response.status }));
        console.error('Failed to send user creation notification:', error);
      }
    } catch (error) {
      // Don't fail user creation if notification fails
      console.error('Error sending user creation notification:', error);
    }
  };

  useEffect(() => {
    if (!auth || !db) {
      setLoading(false);
      return;
    }

    let userDocUnsubscribe: (() => void) | null = null;

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setUser(user);

      // Set Sentry user context for error attribution
      if (user) {
        Sentry.setUser({ id: user.uid, email: user.email || undefined });
      } else {
        Sentry.setUser(null);
      }

      // Clean up previous user document listener
      if (userDocUnsubscribe) {
        userDocUnsubscribe();
        userDocUnsubscribe = null;
      }

      if (user) {
        // User is logged in - create server-side session with HTTPOnly cookie
        try {
          const idToken = await user.getIdToken();
          await createSessionCookie(user.uid, idToken);
        } catch (error) {
          console.error('[Session] Failed to get ID token:', error);
        }

        // Listen to user document for real-time updates
        if (db) {
          const userDocRef = doc(db, 'users', user.uid);

          // Set up real-time listener for user document
          userDocUnsubscribe = onSnapshot(
            userDocRef,
            async (docSnap) => {
              if (docSnap.exists()) {
                const userData = docSnap.data();
                const newRole = userData.role || 'user';
                const newSites: string[] = userData.sites || [];
                const newRequiresMfa = userData.requiresMfaSetup || false;
                const newPasskeyEnrolled = userData.passkeyEnrolled || false;
                const newLastSiteId = userData.lastSiteId || null;
                const newLastMachineIds: Record<string, string> = userData.lastMachineIds || {};

                // Only update state when values actually change to avoid unnecessary re-renders
                setRole(prev => prev === newRole ? prev : newRole);
                setUserSites(prev => arraysEqual(prev, newSites) ? prev : newSites);
                setRequiresMfaSetup(prev => prev === newRequiresMfa ? prev : newRequiresMfa);
                setPasskeyEnrolled(prev => prev === newPasskeyEnrolled ? prev : newPasskeyEnrolled);
                setLastSiteId(prev => prev === newLastSiteId ? prev : newLastSiteId);
                setLastMachineIds(prev => shallowEqual(prev, newLastMachineIds) ? prev : newLastMachineIds);

                // Load user preferences (with defaults if missing)
                const preferences = userData.preferences || {};
                // Validate timeDisplayMode (string union — fall back to 'machine' for unknown/missing)
                const rawTdm = preferences.timeDisplayMode;
                const timeDisplayMode: 'user' | 'machine' | 'site' =
                  rawTdm === 'user' || rawTdm === 'site' ? rawTdm : 'machine';
                const newPrefs: UserPreferences = {
                  temperatureUnit: preferences.temperatureUnit || 'C',
                  timezone: preferences.timezone || getBrowserTimezone(),
                  timeFormat: preferences.timeFormat || '12h',
                  timeDisplayMode,
                  healthAlerts: preferences.healthAlerts !== false, // Default: true
                  processAlerts: preferences.processAlerts !== false, // Default: true
                  thresholdAlerts: preferences.thresholdAlerts !== false, // Default: true
                  cortexAlerts: preferences.cortexAlerts !== false, // Default: true
                  mutedMachines: preferences.mutedMachines || [], // Default: []
                  alertCcEmails: preferences.alertCcEmails || [], // Default: []
                  statsExpanded: preferences.statsExpanded ?? true, // Default: expanded
                  processesExpanded: preferences.processesExpanded ?? true, // Default: expanded
                  graphTabs: preferences.graphTabs || undefined,
                  activeGraphPanel: preferences.activeGraphPanel || null,
                };
                setUserPreferences(prev => {
                  if (
                    prev.temperatureUnit === newPrefs.temperatureUnit &&
                    prev.timezone === newPrefs.timezone &&
                    prev.timeFormat === newPrefs.timeFormat &&
                    prev.timeDisplayMode === newPrefs.timeDisplayMode &&
                    prev.healthAlerts === newPrefs.healthAlerts &&
                    prev.processAlerts === newPrefs.processAlerts &&
                    prev.thresholdAlerts === newPrefs.thresholdAlerts &&
                    prev.cortexAlerts === newPrefs.cortexAlerts &&
                    prev.statsExpanded === newPrefs.statsExpanded &&
                    prev.processesExpanded === newPrefs.processesExpanded &&
                    arraysEqual(prev.mutedMachines, newPrefs.mutedMachines) &&
                    arraysEqual(prev.alertCcEmails, newPrefs.alertCcEmails) &&
                    JSON.stringify(prev.graphTabs || null) === JSON.stringify(newPrefs.graphTabs || null) &&
                    JSON.stringify(prev.activeGraphPanel || null) === JSON.stringify(newPrefs.activeGraphPanel || null)
                  ) return prev;
                  return newPrefs;
                });

                setLoading(false);
              } else {
                // Create user document if it doesn't exist (new user)
                console.log('⚠️ User document missing, creating now...');
                try {
                  const displayName = user.displayName || '';
                  await setDoc(userDocRef, {
                    email: user.email,
                    role: 'user',
                    sites: [],
                    createdAt: new Date(),
                    displayName,
                    // MFA fields for new users
                    mfaEnrolled: false,
                    requiresMfaSetup: true, // Mandatory 2FA for new users
                    // Default preferences
                    preferences: {
                      temperatureUnit: 'C',
                      timezone: getBrowserTimezone(),
                    },
                  });
                  console.log('✅ User document created by listener');

                  // Send user creation notification (likely Google sign-in)
                  sendUserCreatedNotification(
                    user.email || '',
                    displayName,
                    'google'
                  );

                  // Don't set loading to false yet - wait for the listener to fire again
                } catch (firestoreError: any) {
                  console.error('❌ Listener failed to create document:', firestoreError);
                  console.error('Error code:', firestoreError.code);
                  setRole('user');
                  setUserSites([]);
                  setLoading(false);
                }
              }
            },
            (error) => {
              console.error('Error listening to user document:', error);
              setRole('user');
              setUserSites([]);
              setLoading(false);
            }
          );
        } else {
          setRole('user');
          setUserSites([]);
          setLoading(false);
        }
      } else {
        // User is logged out - destroy server-side session and reset role
        destroySessionCookie();
        setRole('user');
        setUserSites([]);
        setLoading(false);
      }
    });

    return () => {
      unsubscribe();
      if (userDocUnsubscribe) {
        userDocUnsubscribe();
      }
    };
  }, []);

  const signIn = async (email: string, password: string) => {
    try {
      if (!auth) {
        const error = new Error('Firebase authentication is not configured. Please check your environment variables.');
        toast.error('Authentication Error', {
          description: 'Firebase is not configured properly. Please contact support.',
        });
        throw error;
      }

      await signInWithEmailAndPassword(auth, email, password);
    } catch (error: any) {
      const friendlyMessage = handleError(error);
      toast.error('Sign In Failed', {
        description: friendlyMessage,
      });
      throw error; // Re-throw so calling component can handle it
    }
  };

  const signUp = async (email: string, password: string, firstName?: string, lastName?: string) => {
    try {
      if (!auth || !db) {
        const error = new Error('Firebase authentication is not configured. Please check your environment variables.');
        toast.error('Authentication Error', {
          description: 'Firebase is not configured properly. Please contact support.',
        });
        throw error;
      }

      const userCredential = await createUserWithEmailAndPassword(auth, email, password);

      // Set display name if first/last name provided
      if (firstName || lastName) {
        const displayName = [firstName, lastName].filter(Boolean).join(' ');
        await updateProfile(userCredential.user, { displayName });
      }

      // Immediately create user document in Firestore
      const userDocRef = doc(db, 'users', userCredential.user.uid);
      try {
        const displayName = [firstName, lastName].filter(Boolean).join(' ') || '';
        await setDoc(userDocRef, {
          email: userCredential.user.email,
          role: 'user',
          sites: [],
          createdAt: new Date(),
          displayName,
          // MFA fields for new users
          mfaEnrolled: false,
          requiresMfaSetup: true, // Mandatory 2FA for new users
          // Default preferences
          preferences: {
            temperatureUnit: 'C',
            timezone: getBrowserTimezone(),
          },
        });
        console.log('✅ User document created in Firestore:', userCredential.user.uid);

        // Send user creation notification
        sendUserCreatedNotification(
          userCredential.user.email || '',
          displayName,
          'email'
        );
      } catch (firestoreError: any) {
        console.error('❌ Failed to create user document:', firestoreError);
        console.error('Error code:', firestoreError.code);
        console.error('Error message:', firestoreError.message);
        // Don't throw - let the user continue even if Firestore fails
        // The onAuthStateChanged listener will retry
      }

      toast.success('Account Created', {
        description: 'Your account has been created successfully. You can now sign in.',
      });
    } catch (error: any) {
      const friendlyMessage = handleError(error);
      toast.error('Sign Up Failed', {
        description: friendlyMessage,
      });
      throw error; // Re-throw so calling component can handle it
    }
  };

  const signInWithGoogle = async () => {
    try {
      if (!auth) {
        const error = new Error('Firebase authentication is not configured. Please check your environment variables.');
        toast.error('Authentication Error', {
          description: 'Firebase is not configured properly. Please contact support.',
        });
        throw error;
      }

      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (error: any) {
      // Don't show toast for popup closed by user
      if (error.code === 'auth/popup-closed-by-user' || error.code === 'auth/cancelled-popup-request') {
        throw error;
      }

      const friendlyMessage = handleError(error);
      toast.error('Google Sign In Failed', {
        description: friendlyMessage,
      });
      throw error; // Re-throw so calling component can handle it
    }
  };

  const signOut = async () => {
    try {
      if (!auth) {
        const error = new Error('Firebase authentication is not configured.');
        toast.error('Authentication Error', {
          description: 'Firebase is not configured properly.',
        });
        throw error;
      }

      await firebaseSignOut(auth);
      await destroySessionCookie();
      clearMfaSession(); // Clear MFA verification status
      toast.success('Signed Out', {
        description: 'You have been signed out successfully.',
      });
    } catch (error: any) {
      const friendlyMessage = handleError(error);
      toast.error('Sign Out Failed', {
        description: friendlyMessage,
      });
      throw error; // Re-throw so calling component can handle it
    }
  };

  const updateUserProfile = async (firstName: string, lastName: string) => {
    try {
      if (!auth?.currentUser) {
        const error = new Error('No user is currently signed in.');
        toast.error('Update Failed', {
          description: 'You must be signed in to update your profile.',
        });
        throw error;
      }

      const displayName = [firstName, lastName].filter(Boolean).join(' ').trim();

      if (!displayName) {
        const error = new Error('Please provide at least a first or last name.');
        toast.error('Update Failed', {
          description: 'Please provide at least a first or last name.',
        });
        throw error;
      }

      await updateProfile(auth.currentUser, { displayName });

      // Force a refresh of the user object
      setUser({ ...auth.currentUser });

      toast.success('Profile Updated', {
        description: 'Your profile has been updated successfully.',
      });
    } catch (error: any) {
      const friendlyMessage = handleError(error);
      toast.error('Update Failed', {
        description: friendlyMessage,
      });
      throw error;
    }
  };

  const updateUserPhoto = async (photoBlob: Blob | null) => {
    try {
      if (!auth?.currentUser) {
        throw new Error('No user is currently signed in.');
      }
      if (!storage) {
        throw new Error('Storage is not initialized.');
      }

      const uid = auth.currentUser.uid;
      const avatarRef = storageRef(storage, `users/${uid}/avatar.jpg`);

      if (photoBlob) {
        await uploadBytes(avatarRef, photoBlob, { contentType: 'image/jpeg' });
        const downloadUrl = await getDownloadURL(avatarRef);
        await updateProfile(auth.currentUser, { photoURL: downloadUrl });
      } else {
        // Remove: best-effort delete the object, then clear photoURL
        try {
          await deleteObject(avatarRef);
        } catch (err: unknown) {
          // Object may not exist — only re-throw unexpected errors
          const code = (err as { code?: string } | null)?.code;
          if (code !== 'storage/object-not-found') {
            throw err;
          }
        }
        await updateProfile(auth.currentUser, { photoURL: '' });
      }

      setUser({ ...auth.currentUser });

      toast.success(photoBlob ? 'Photo Updated' : 'Photo Removed', {
        description: photoBlob
          ? 'Your profile photo has been updated.'
          : 'Your profile photo has been removed.',
      });
    } catch (error: unknown) {
      const friendlyMessage = handleError(error);
      toast.error('Photo Update Failed', {
        description: friendlyMessage,
      });
      throw error;
    }
  };

  const updateUserPreferences = async (preferences: Partial<UserPreferences>, options?: { silent?: boolean }) => {
    try {
      if (!auth?.currentUser || !db) {
        const error = new Error('No user is currently signed in.');
        toast.error('Update Failed', {
          description: 'You must be signed in to update your preferences.',
        });
        throw error;
      }

      const userDocRef = doc(db, 'users', auth.currentUser.uid);

      // Merge with existing preferences
      await setDoc(userDocRef, {
        preferences: {
          ...userPreferences,
          ...preferences,
        },
      }, { merge: true });

      // Update local state
      setUserPreferences({
        ...userPreferences,
        ...preferences,
      });

      if (!options?.silent) {
        toast.success('Preferences Updated', {
          description: 'Your preferences have been saved successfully.',
        });
      }
    } catch (error: any) {
      const friendlyMessage = handleError(error);
      toast.error('Update Failed', {
        description: friendlyMessage,
      });
      throw error;
    }
  };

  const updateLastSite = (siteId: string) => {
    setLastSiteId(siteId);
    // Also keep localStorage for fast same-browser access
    localStorage.setItem('owlette_current_site', siteId);
    // Write to Firestore (fire-and-forget for responsiveness)
    if (auth?.currentUser && db) {
      const userDocRef = doc(db, 'users', auth.currentUser.uid);
      setDoc(userDocRef, { lastSiteId: siteId }, { merge: true }).catch((err) =>
        console.error('Failed to save lastSiteId:', err)
      );
    }
  };

  const updateLastMachine = (siteId: string, machineId: string) => {
    setLastMachineIds((prev) => ({ ...prev, [siteId]: machineId }));
    if (auth?.currentUser && db) {
      const userDocRef = doc(db, 'users', auth.currentUser.uid);
      setDoc(userDocRef, { lastMachineIds: { [siteId]: machineId } }, { merge: true }).catch((err) =>
        console.error('Failed to save lastMachineId:', err)
      );
    }
  };

  const updatePassword = async (currentPassword: string, newPassword: string) => {
    try {
      if (!auth?.currentUser) {
        const error = new Error('No user is currently signed in.');
        toast.error('Update Failed', {
          description: 'You must be signed in to update your password.',
        });
        throw error;
      }

      if (!auth.currentUser.email) {
        const error = new Error('Cannot update password for accounts without email.');
        toast.error('Update Failed', {
          description: 'Password updates are only available for email/password accounts.',
        });
        throw error;
      }

      // Re-authenticate user with current password
      const credential = EmailAuthProvider.credential(
        auth.currentUser.email,
        currentPassword
      );

      await reauthenticateWithCredential(auth.currentUser, credential);

      // Update to new password
      await firebaseUpdatePassword(auth.currentUser, newPassword);

      toast.success('Password Updated', {
        description: 'Your password has been updated successfully.',
      });
    } catch (error: any) {
      // Handle specific re-authentication errors
      if (error.code === 'auth/wrong-password' || error.code === 'auth/invalid-credential') {
        toast.error('Update Failed', {
          description: 'Current password is incorrect.',
        });
      } else if (error.code === 'auth/weak-password') {
        toast.error('Update Failed', {
          description: 'New password is too weak. Please choose a stronger password.',
        });
      } else {
        const friendlyMessage = handleError(error);
        toast.error('Update Failed', {
          description: friendlyMessage,
        });
      }
      throw error;
    }
  };

  const deleteAccount = async (password: string) => {
    try {
      if (!auth?.currentUser || !db) {
        const error = new Error('No user is currently signed in.');
        toast.error('Deletion Failed', {
          description: 'You must be signed in to delete your account.',
        });
        throw error;
      }

      const userId = auth.currentUser.uid;

      // Re-authenticate user with password
      if (auth.currentUser.email) {
        const credential = EmailAuthProvider.credential(
          auth.currentUser.email,
          password
        );
        await reauthenticateWithCredential(auth.currentUser, credential);
      }

      // Delete all sites owned by the user
      // Note: We only delete sites where the user is the sole owner
      // Sites with multiple users should just remove this user from the sites array
      const userDocRef = doc(db, 'users', userId);
      const userDocSnap = await getDoc(userDocRef);

      if (userDocSnap.exists()) {
        const userData = userDocSnap.data();
        const userSiteIds = userData.sites || [];

        // Use batch for efficient deletion
        const batch = writeBatch(db);

        // Delete each site owned by the user
        for (const siteId of userSiteIds) {
          const siteRef = doc(db, 'sites', siteId);
          const siteSnap = await getDoc(siteRef);

          if (siteSnap.exists()) {
            // Delete the site document
            batch.delete(siteRef);

            // Delete all machines in the site
            const machinesRef = collection(db, `sites/${siteId}/machines`);
            const machinesSnap = await getDocs(machinesRef);
            machinesSnap.docs.forEach((machineDoc) => {
              batch.delete(machineDoc.ref);
            });

            // Delete all deployments in the site
            const deploymentsRef = collection(db, `sites/${siteId}/deployments`);
            const deploymentsSnap = await getDocs(deploymentsRef);
            deploymentsSnap.docs.forEach((deploymentDoc) => {
              batch.delete(deploymentDoc.ref);
            });

            // Delete all logs in the site
            const logsRef = collection(db, `sites/${siteId}/logs`);
            const logsSnap = await getDocs(logsRef);
            logsSnap.docs.forEach((logDoc) => {
              batch.delete(logDoc.ref);
            });
          }
        }

        // Delete user document
        batch.delete(userDocRef);

        // Commit all deletions
        await batch.commit();
      }

      // Delete Firebase Auth account
      await deleteUser(auth.currentUser);

      // Destroy server-side session
      await destroySessionCookie();

      toast.success('Account Deleted', {
        description: 'Your account has been permanently deleted.',
      });
    } catch (error: any) {
      // Handle specific errors
      if (error.code === 'auth/wrong-password' || error.code === 'auth/invalid-credential') {
        toast.error('Deletion Failed', {
          description: 'Password is incorrect.',
        });
      } else if (error.code === 'auth/requires-recent-login') {
        toast.error('Deletion Failed', {
          description: 'Please sign out and sign in again before deleting your account.',
        });
      } else {
        const friendlyMessage = handleError(error);
        toast.error('Deletion Failed', {
          description: friendlyMessage,
        });
      }
      throw error;
    }
  };

  const isAdmin = role === 'admin';

  const value = useMemo(() => ({
    user,
    loading,
    role,
    isAdmin,
    userSites,
    lastSiteId,
    lastMachineIds,
    requiresMfaSetup,
    passkeyEnrolled,
    userPreferences,
    signIn,
    signUp,
    signInWithGoogle,
    signOut,
    updateUserProfile,
    updateUserPhoto,
    updatePassword,
    updateUserPreferences,
    updateLastSite,
    updateLastMachine,
    deleteAccount,
  }), [user, loading, role, isAdmin, userSites, lastSiteId, lastMachineIds, requiresMfaSetup, passkeyEnrolled, userPreferences, signIn, signUp, signInWithGoogle, signOut, updateUserProfile, updateUserPhoto, updatePassword, updateUserPreferences, updateLastSite, updateLastMachine, deleteAccount]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
