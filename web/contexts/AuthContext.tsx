'use client';

import { createContext, useContext, useEffect, useState, useMemo, useCallback, useRef } from 'react';
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
import { doc, setDoc, onSnapshot } from 'firebase/firestore';
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

// Structural deep-equal for preference snapshot diffing. Used instead of
// JSON.stringify because Firestore does not guarantee object key order, so
// stringify-based equality produces spurious mismatches (and reference churn
// downstream) when the server returns the same logical object with a
// different key order.
function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!isDeepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
    if (!isDeepEqual(aObj[key], bObj[key])) return false;
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

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    return body.detail ?? body.title ?? `${fallback} (${response.status})`;
  } catch {
    return `${fallback} (${response.status})`;
  }
}

const bootstrapUserDocument = async (
  user: User,
  displayName: string
): Promise<{ alreadyExists: boolean }> => {
  const idToken = await user.getIdToken();
  const response = await fetch('/api/users/bootstrap', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      email: user.email,
      displayName,
      timezone: getBrowserTimezone(),
    }),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json() as Promise<{ alreadyExists: boolean }>;
};

export type UserRole = 'member' | 'admin' | 'superadmin';

/**
 * Pure helper: is the user a platform-wide superadmin?
 * Extracted (and exported) so it's unit-testable without mounting AuthProvider.
 */
export function computeIsSuperadmin(role: UserRole | null): boolean {
  return role === 'superadmin';
}

/**
 * Pure helper: is the user a site-admin for the given site?
 * Superadmins pass for every siteId (god-mode fall-through); admins pass only
 * when siteId is in their assigned `userSites[]`. Everyone else is false.
 * Extracted (and exported) so it's unit-testable without mounting AuthProvider.
 */
export function computeIsSiteAdmin(
  role: UserRole | null,
  userSites: string[],
  siteId: string
): boolean {
  return role === 'superadmin' || (role === 'admin' && userSites.includes(siteId));
}

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
  displayAlerts: boolean; // Receive email alerts when display layout / topology events fire (drift, monitor removed, apply failed, auto-revert, etc). Default: true
  displayAlertsBannerDismissed: boolean; // [B4.3] One-shot dismissal of the "new: display alerts" banner on /admin/alerts. Default: false (banner shows). The banner also auto-hides after 30 days from feature launch regardless of dismissal state.
  mutedMachines: string[]; // Machine IDs to suppress all alerts for. Default: []
  alertCcEmails: string[]; // Additional CC recipients for alert emails. Default: []
  statsExpanded: boolean; // Whether stats section is expanded in card view. Default: false
  processesExpanded: boolean; // Whether process list is expanded in card view. Default: false
  displaysExpanded?: boolean; // Whether displays section is expanded in card view. Default: false
  /** Remembered graph tab selection for each machine's MetricsDetailPanel.
   * Keyed by machineId → array of namespaced tab ids (e.g. 'metric:cpu', 'nic:Ethernet 2', 'gpu:0').
   * Unknown namespaces are ignored on read, so new entity types slot in without migration. */
  graphTabs?: Record<string, string[]>;
  /** Which machine's MetricsDetailPanel is currently open, and the metric that opened it.
   * Null/absent when no panel is open. Persisted so the panel reappears after reload. */
  activeGraphPanel?: { machineId: string; metric: string } | null;
  /** Selected time range for the MetricsDetailPanel (global, not per-machine).
   * One of: '1h' | '1d' | '1w' | '1m' | '1y' | 'all'. Default: '1h'. */
  graphTimeRange?: '1h' | '1d' | '1w' | '1m' | '1y' | 'all';
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  /** User's role from Firestore; null until the user doc loads (pre-auth, missing doc, or listener error). */
  role: UserRole | null;
  /** True when role === 'superadmin' — platform-wide god-mode. Use for installer uploads, role management, cross-site admining. */
  isSuperadmin: boolean;
  /** True when the user is an admin or superadmin of the given site. Superadmins pass for every siteId; admins pass only for sites in their userSites[]. Use for site-level elevated operations (delete machines, edit stored layouts, site webhooks/settings). */
  isSiteAdmin: (siteId: string) => boolean;
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
  role: null,
  isSuperadmin: false,
  isSiteAdmin: () => false,
  userSites: [],
  lastSiteId: null,
  lastMachineIds: {},
  requiresMfaSetup: false,
  passkeyEnrolled: false,
  userPreferences: { temperatureUnit: 'C', timezone: 'UTC', timeFormat: '12h', timeDisplayMode: 'machine', healthAlerts: true, processAlerts: true, thresholdAlerts: true, cortexAlerts: true, displayAlerts: true, displayAlertsBannerDismissed: false, mutedMachines: [], alertCcEmails: [], statsExpanded: true, processesExpanded: true },
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
  const [role, setRole] = useState<UserRole | null>(null);
  const [userSites, setUserSites] = useState<string[]>([]);
  const [requiresMfaSetup, setRequiresMfaSetup] = useState(false);
  const [passkeyEnrolled, setPasskeyEnrolled] = useState(false);
  const [userPreferences, setUserPreferences] = useState<UserPreferences>({ temperatureUnit: 'C', timezone: getBrowserTimezone(), timeFormat: '12h', timeDisplayMode: 'machine', healthAlerts: true, processAlerts: true, thresholdAlerts: true, cortexAlerts: true, displayAlerts: true, displayAlertsBannerDismissed: false, mutedMachines: [], alertCcEmails: [], statsExpanded: true, processesExpanded: true });
  // Mirror userPreferences in a ref so updateUserPreferences can read the
  // current value without putting userPreferences in its useCallback deps —
  // putting it in deps caused stale closures to overwrite recent changes
  // when callers stacked rapid updates (e.g. cell-click + sparkline-toggle).
  const userPreferencesRef = useRef(userPreferences);
  useEffect(() => { userPreferencesRef.current = userPreferences; }, [userPreferences]);
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
                const rawRole = userData.role;
                const newRole: UserRole | null =
                  rawRole === 'member' || rawRole === 'admin' || rawRole === 'superadmin'
                    ? rawRole
                    : null;
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
                  displayAlerts: preferences.displayAlerts !== false, // Default: true
                  displayAlertsBannerDismissed: preferences.displayAlertsBannerDismissed === true, // Default: false (banner shows)
                  mutedMachines: preferences.mutedMachines || [], // Default: []
                  alertCcEmails: preferences.alertCcEmails || [], // Default: []
                  statsExpanded: preferences.statsExpanded ?? true, // Default: expanded
                  processesExpanded: preferences.processesExpanded ?? true, // Default: expanded
                  displaysExpanded: preferences.displaysExpanded ?? true, // Default: expanded
                  graphTabs: preferences.graphTabs || undefined,
                  activeGraphPanel: preferences.activeGraphPanel || null,
                  graphTimeRange: preferences.graphTimeRange || undefined,
                };
                setUserPreferences(prev => {
                  // Per-field reference preservation: when a field's content
                  // hasn't changed, keep prev's reference. This prevents
                  // downstream consumers (e.g. MetricsDetailPanel's
                  // reconciliation effect) from re-firing on identity changes
                  // and reverting unrelated state.
                  const graphTabsEqual = isDeepEqual(prev.graphTabs ?? null, newPrefs.graphTabs ?? null);
                  const activeGraphPanelEqual = isDeepEqual(prev.activeGraphPanel ?? null, newPrefs.activeGraphPanel ?? null);
                  const mutedEqual = arraysEqual(prev.mutedMachines, newPrefs.mutedMachines);
                  const ccEqual = arraysEqual(prev.alertCcEmails, newPrefs.alertCcEmails);

                  const allEqual =
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
                    prev.displaysExpanded === newPrefs.displaysExpanded &&
                    mutedEqual && ccEqual && graphTabsEqual && activeGraphPanelEqual &&
                    prev.graphTimeRange === newPrefs.graphTimeRange;
                  if (allEqual) return prev;

                  // At least one field changed — build next, preserving stable
                  // refs for unchanged object/array fields.
                  return {
                    ...newPrefs,
                    graphTabs: graphTabsEqual ? prev.graphTabs : newPrefs.graphTabs,
                    activeGraphPanel: activeGraphPanelEqual ? prev.activeGraphPanel : newPrefs.activeGraphPanel,
                    mutedMachines: mutedEqual ? prev.mutedMachines : newPrefs.mutedMachines,
                    alertCcEmails: ccEqual ? prev.alertCcEmails : newPrefs.alertCcEmails,
                  };
                });

                setLoading(false);
              } else {
                // Create user document if it doesn't exist (new user)
                console.log('⚠️ User document missing, creating now...');
                try {
                  const displayName = user.displayName || '';
                  const bootstrap = await bootstrapUserDocument(user, displayName);
                  console.log('✅ User document created by listener');

                  // Send user creation notification (likely Google sign-in)
                  if (!bootstrap.alreadyExists) {
                    sendUserCreatedNotification(
                      user.email || '',
                      displayName,
                      'google'
                    );
                  }

                  // Don't set loading to false yet - wait for the listener to fire again
                } catch (bootstrapError: unknown) {
                  const err = bootstrapError as { message?: string } | null;
                  console.error('listener failed to bootstrap document:', bootstrapError);
                  console.error('Error message:', err?.message);
                  setRole(null);
                  setUserSites([]);
                  setLoading(false);
                }
              }
            },
            (error) => {
              console.error('Error listening to user document:', error);
              setRole(null);
              setUserSites([]);
              setLoading(false);
            }
          );
        } else {
          setRole(null);
          setUserSites([]);
          setLoading(false);
        }
      } else {
        // User is logged out - destroy server-side session and reset role
        destroySessionCookie();
        setRole(null);
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

  const signIn = useCallback(async (email: string, password: string) => {
    try {
      if (!auth) {
        const error = new Error('Firebase authentication is not configured. Please check your environment variables.');
        toast.error('Authentication Error', {
          description: 'Firebase is not configured properly. Please contact support.',
        });
        throw error;
      }

      await signInWithEmailAndPassword(auth, email, password);
    } catch (error: unknown) {
      const friendlyMessage = handleError(error);
      toast.error('Sign In Failed', {
        description: friendlyMessage,
      });
      throw error; // Re-throw so calling component can handle it
    }
  }, []);

  const signUp = useCallback(async (email: string, password: string, firstName?: string, lastName?: string) => {
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

      // Immediately bootstrap the user document server-side.
      try {
        const displayName = [firstName, lastName].filter(Boolean).join(' ') || '';
        const bootstrap = await bootstrapUserDocument(userCredential.user, displayName);
        console.log('✅ User document created in Firestore:', userCredential.user.uid);

        // Send user creation notification
        if (!bootstrap.alreadyExists) {
          sendUserCreatedNotification(
            userCredential.user.email || '',
            displayName,
            'email'
          );
        }
      } catch (bootstrapError: unknown) {
        const err = bootstrapError as { message?: string } | null;
        console.error('failed to bootstrap user document:', bootstrapError);
        console.error('Error message:', err?.message);
        // Don't throw - let the user continue even if Firestore fails
        // The onAuthStateChanged listener will retry
      }

      toast.success('Account Created', {
        description: 'Your account has been created successfully. You can now sign in.',
      });
    } catch (error: unknown) {
      const friendlyMessage = handleError(error);
      toast.error('Sign Up Failed', {
        description: friendlyMessage,
      });
      throw error; // Re-throw so calling component can handle it
    }
  }, []);

  const signInWithGoogle = useCallback(async () => {
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
    } catch (error: unknown) {
      const code = (error as { code?: string } | null)?.code;
      // Don't show toast for popup closed by user
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        throw error;
      }

      const friendlyMessage = handleError(error);
      toast.error('Google Sign In Failed', {
        description: friendlyMessage,
      });
      throw error; // Re-throw so calling component can handle it
    }
  }, []);

  const signOut = useCallback(async () => {
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
    } catch (error: unknown) {
      const friendlyMessage = handleError(error);
      toast.error('Sign Out Failed', {
        description: friendlyMessage,
      });
      throw error; // Re-throw so calling component can handle it
    }
  }, []);

  const updateUserProfile = useCallback(async (firstName: string, lastName: string) => {
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
    } catch (error: unknown) {
      const friendlyMessage = handleError(error);
      toast.error('Update Failed', {
        description: friendlyMessage,
      });
      throw error;
    }
  }, []);

  const updateUserPhoto = useCallback(async (photoBlob: Blob | null) => {
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
  }, []);

  const updateUserPreferences = useCallback(async (preferences: Partial<UserPreferences>, options?: { silent?: boolean }) => {
    try {
      if (!auth?.currentUser || !db) {
        const error = new Error('No user is currently signed in.');
        toast.error('Update Failed', {
          description: 'You must be signed in to update your preferences.',
        });
        throw error;
      }

      const userDocRef = doc(db, 'users', auth.currentUser.uid);

      // Always read the latest userPreferences via ref so rapid stacked
      // updates don't overwrite each other with stale closure values.
      const current = userPreferencesRef.current;
      const merged = { ...current, ...preferences };

      // Strip undefined values — Firestore rejects them with
      // `Function setDoc() called with invalid data. Unsupported field value:
      // undefined`. Optional fields that have never been set (e.g.
      // activeGraphPanel before the user opens a graph) sit in `current` as
      // undefined and would otherwise propagate into every preference write.
      const sanitized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(merged)) {
        if (value !== undefined) sanitized[key] = value;
      }

      // Merge with existing preferences in Firestore
      await setDoc(userDocRef, { preferences: sanitized }, { merge: true });

      // Update local state via functional setter so concurrent setUserPreferences
      // calls (e.g. from the Firestore snapshot listener) compose correctly.
      setUserPreferences((prev) => ({ ...prev, ...preferences }));

      if (!options?.silent) {
        toast.success('Preferences Updated', {
          description: 'Your preferences have been saved successfully.',
        });
      }
    } catch (error: unknown) {
      const friendlyMessage = handleError(error);
      toast.error('Update Failed', {
        description: friendlyMessage,
      });
      throw error;
    }
  }, []);

  const updateLastSite = useCallback((siteId: string) => {
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
  }, []);

  const updateLastMachine = useCallback((siteId: string, machineId: string) => {
    setLastMachineIds((prev) => ({ ...prev, [siteId]: machineId }));
    if (auth?.currentUser && db) {
      const userDocRef = doc(db, 'users', auth.currentUser.uid);
      setDoc(userDocRef, { lastMachineIds: { [siteId]: machineId } }, { merge: true }).catch((err) =>
        console.error('Failed to save lastMachineId:', err)
      );
    }
  }, []);

  const updatePassword = useCallback(async (currentPassword: string, newPassword: string) => {
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
    } catch (error: unknown) {
      const code = (error as { code?: string } | null)?.code;
      // Handle specific re-authentication errors
      if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
        toast.error('Update Failed', {
          description: 'Current password is incorrect.',
        });
      } else if (code === 'auth/weak-password') {
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
  }, []);

  const deleteAccount = useCallback(async (password: string) => {
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

      const response = await fetch('/api/users/me', {
        method: 'DELETE',
        headers: { 'idempotency-key': `account-delete-${userId}` },
      });
      if (!response.ok) {
        throw new Error(await readApiError(response, 'Failed to delete account data'));
      }

      // Delete Firebase Auth account
      await deleteUser(auth.currentUser);

      // Destroy server-side session
      await destroySessionCookie();

      toast.success('Account Deleted', {
        description: 'Your account has been permanently deleted.',
      });
    } catch (error: unknown) {
      const code = (error as { code?: string } | null)?.code;
      // Handle specific errors
      if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
        toast.error('Deletion Failed', {
          description: 'Password is incorrect.',
        });
      } else if (code === 'auth/requires-recent-login') {
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
  }, []);

  const isSuperadmin = computeIsSuperadmin(role);
  const isSiteAdmin = useCallback(
    (siteId: string) => computeIsSiteAdmin(role, userSites, siteId),
    [role, userSites]
  );

  const value = useMemo(() => ({
    user,
    loading,
    role,
    isSuperadmin,
    isSiteAdmin,
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
  }), [user, loading, role, isSuperadmin, isSiteAdmin, userSites, lastSiteId, lastMachineIds, requiresMfaSetup, passkeyEnrolled, userPreferences, signIn, signUp, signInWithGoogle, signOut, updateUserProfile, updateUserPhoto, updatePassword, updateUserPreferences, updateLastSite, updateLastMachine, deleteAccount]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
