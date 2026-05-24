'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  collection,
  query,
  onSnapshot,
  orderBy,
  Timestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { handleError } from '@/lib/errorHandler';

export type UserRole = 'member' | 'admin' | 'superadmin';

export interface UserData {
  uid: string;
  email: string;
  role: UserRole;
  sites?: string[];
  createdAt: Timestamp;
  displayName?: string;
  deletedAt?: number;
  deletedBy?: string;
}

interface UserActivity {
  lastSignInTime: string | null;
  lastRefreshTime: string | null;
  disabled: boolean;
}

/**
 * useUserManagement Hook
 *
 * Provides functionality for admin users to manage all users in the system.
 *
 * Features:
 * - Real-time list of all users
 * - Update user roles
 * - Sort and filter users
 *
 * Usage:
 * const { users, loading, error, updateUserRole } = useUserManagement();
 */
export function useUserManagement() {
  const [users, setUsers] = useState<UserData[]>([]);
  const [loading, setLoading] = useState(!!db);
  const [error, setError] = useState<string | null>(db ? null : 'Firebase is not configured');
  const [activity, setActivity] = useState<Record<string, UserActivity>>({});

  // Fetch all users with real-time updates
  useEffect(() => {
    if (!db) return;

    // No try/catch: `collection()`/`query()` only throw for invalid path or
    // query shape (both literals here), and onSnapshot surfaces runtime
    // listener errors through its error callback. A sync catch-block setState
    // would violate react-hooks/set-state-in-effect.
    const usersRef = collection(db, 'users');
    const q = query(usersRef, orderBy('createdAt', 'desc'));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const usersData: UserData[] = [];

        snapshot.forEach((doc) => {
          usersData.push({
            uid: doc.id,
            ...doc.data(),
          } as UserData);
        });

        setUsers(usersData);
        setLoading(false);
        setError(null);
      },
      (err) => {
        console.error('Error fetching users:', err);
        const friendlyMessage = handleError(err);
        setError(friendlyMessage);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, []);

  // Stable key derived from the uid set so the activity fetch only re-fires
  // when the membership changes, not on every snapshot emission.
  const uidKey = useMemo(
    () => users.map((u) => u.uid).sort().join(','),
    [users]
  );

  // Fetch Firebase Auth sign-in metadata (last-seen) keyed by uid. Non-fatal:
  // the user table renders without activity if this fails.
  useEffect(() => {
    if (!uidKey) return;

    let cancelled = false;

    (async () => {
      try {
        const response = await fetch('/api/users/activity');
        if (!response.ok) {
          console.error('Error fetching user activity:', response.status);
          return;
        }
        const body = await response.json();
        if (cancelled) return;
        setActivity(body.activity ?? {});
      } catch (err) {
        console.error('Error fetching user activity:', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [uidKey]);

  /**
   * Update a user's role
   *
   * @param userId - The user's UID
   * @param newRole - The new role ('user' or 'admin')
   */
  const updateUserRole = useCallback(
    async (userId: string, newRole: UserRole): Promise<void> => {
      if (!db) {
        throw new Error('Firebase is not configured');
      }

      try {
        const endpoint =
          newRole === 'member'
            ? `/api/users/${encodeURIComponent(userId)}/demote`
            : `/api/users/${encodeURIComponent(userId)}/promote`;
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role: newRole }),
        });
        if (!response.ok) throw new Error(await readApiError(response, 'Failed to update user role'));
      } catch (err) {
        console.error('Error updating user role:', err);
        throw new Error(handleError(err));
      }
    },
    []
  );

  /**
   * Get count of users by role under the three-tier permission model.
   * - superadmins: platform-wide god-mode
   * - admins: site-scoped elevated tier (can edit site config on their assigned sites)
   * - members: standard users with site-level access
   */
  const getUserCounts = useCallback(() => {
    const active = users.filter((u) => u.deletedAt == null);
    const superadmins = active.filter((u) => u.role === 'superadmin').length;
    const admins = active.filter((u) => u.role === 'admin').length;
    const members = active.filter((u) => u.role === 'member').length;

    return {
      total: active.length,
      superadmins,
      admins,
      members,
      deleted: users.length - active.length,
    };
  }, [users]);

  /**
   * Assign a site to a user
   *
   * @param userId - The user's UID
   * @param siteId - The site ID to assign
   */
  const assignSiteToUser = useCallback(
    async (userId: string, siteId: string): Promise<void> => {
      if (!db) {
        throw new Error('Firebase is not configured');
      }

      try {
        const response = await fetch(`/api/users/${encodeURIComponent(userId)}/assign-sites`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ siteIds: [siteId] }),
        });
        if (!response.ok) throw new Error(await readApiError(response, 'Failed to assign site'));
      } catch (err) {
        console.error('Error assigning site to user:', err);
        throw new Error(handleError(err));
      }
    },
    []
  );

  /**
   * Remove a site from a user
   *
   * @param userId - The user's UID
   * @param siteId - The site ID to remove
   */
  const removeSiteFromUser = useCallback(
    async (userId: string, siteId: string): Promise<void> => {
      if (!db) {
        throw new Error('Firebase is not configured');
      }

      try {
        const response = await fetch(`/api/users/${encodeURIComponent(userId)}/remove-sites`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ siteIds: [siteId] }),
        });
        if (!response.ok) throw new Error(await readApiError(response, 'Failed to remove site'));
      } catch (err) {
        console.error('Error removing site from user:', err);
        throw new Error(handleError(err));
      }
    },
    []
  );

  /**
   * Delete a user
   *
   * @param userId - The user's UID
   */
  const deleteUser = useCallback(
    async (userId: string): Promise<void> => {
      if (!db) {
        throw new Error('Firebase is not configured');
      }

      try {
        const response = await fetch(`/api/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
        if (!response.ok) throw new Error(await readApiError(response, 'Failed to delete user'));
      } catch (err) {
        console.error('Error deleting user:', err);
        throw new Error(handleError(err));
      }
    },
    []
  );

  return {
    users,
    activity,
    loading,
    error,
    updateUserRole,
    getUserCounts,
    assignSiteToUser,
    removeSiteFromUser,
    deleteUser,
  };
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    return body.detail ?? body.title ?? `${fallback} (${response.status})`;
  } catch {
    return `${fallback} (${response.status})`;
  }
}
