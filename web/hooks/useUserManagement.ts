'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  collection,
  query,
  onSnapshot,
  doc,
  updateDoc,
  orderBy,
  Timestamp,
  arrayUnion,
  arrayRemove,
  deleteDoc,
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch all users with real-time updates
  useEffect(() => {
    if (!db) {
      setError('Firebase is not configured');
      setLoading(false);
      return;
    }

    try {
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
    } catch (err) {
      console.error('Error setting up users listener:', err);
      const friendlyMessage = handleError(err);
      setError(friendlyMessage);
      setLoading(false);
    }
  }, []);

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
        const userRef = doc(db, 'users', userId);
        await updateDoc(userRef, {
          role: newRole,
        });
      } catch (err) {
        console.error('Error updating user role:', err);
        throw new Error(handleError(err));
      }
    },
    []
  );

  /**
   * Get count of users by role
   */
  const getUserCounts = useCallback(() => {
    const adminCount = users.filter((u) => u.role === 'admin').length;
    const userCount = users.filter((u) => u.role === 'member').length;

    return {
      total: users.length,
      admins: adminCount,
      users: userCount,
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
        const userRef = doc(db, 'users', userId);
        await updateDoc(userRef, {
          sites: arrayUnion(siteId),
        });
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
        const userRef = doc(db, 'users', userId);
        await updateDoc(userRef, {
          sites: arrayRemove(siteId),
        });
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
        const userRef = doc(db, 'users', userId);
        await deleteDoc(userRef);
      } catch (err) {
        console.error('Error deleting user:', err);
        throw new Error(handleError(err));
      }
    },
    []
  );

  return {
    users,
    loading,
    error,
    updateUserRole,
    getUserCounts,
    assignSiteToUser,
    removeSiteFromUser,
    deleteUser,
  };
}
