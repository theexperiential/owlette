'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  collection,
  query,
  onSnapshot,
  doc,
  setDoc,
  deleteDoc,
  orderBy,
  Timestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { handleError } from '@/lib/errorHandler';
import {
  uploadInstaller,
  deleteInstallerVersion,
} from '@/lib/storageUtils';
import { useAuth } from '@/contexts/AuthContext';

export interface InstallerVersion {
  id: string; // Version number (e.g., "2.0.0")
  version: string;
  download_url: string;
  file_size: number;
  release_date: Timestamp;
  checksum_sha256: string;
  release_notes?: string;
  uploaded_by: string;
  is_latest?: boolean;
}

/**
 * useInstallerManagement Hook
 *
 * Provides functionality for admin users to manage agent installer versions.
 *
 * Features:
 * - Real-time list of all versions
 * - Upload new versions
 * - Set version as latest
 * - Delete versions
 *
 * Usage:
 * const { versions, loading, uploadVersion, setAsLatest, deleteVersion } = useInstallerManagement();
 */
export function useInstallerManagement() {
  const { user } = useAuth();
  const [versions, setVersions] = useState<InstallerVersion[]>([]);
  const [latestVersion, setLatestVersion] = useState<InstallerVersion | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch all versions with real-time updates
  useEffect(() => {
    if (!db) {
      setError('Firebase is not configured');
      setLoading(false);
      return;
    }

    try {
      const versionsRef = collection(db, 'installer_metadata', 'data', 'versions');
      const q = query(versionsRef, orderBy('release_date', 'desc'));

      const unsubscribe = onSnapshot(
        q,
        (snapshot) => {
          const versionsData: InstallerVersion[] = [];

          snapshot.forEach((doc) => {
            versionsData.push({
              id: doc.id,
              ...doc.data(),
            } as InstallerVersion);
          });

          setVersions(versionsData);
          setLoading(false);
          setError(null);
        },
        (err) => {
          console.error('Error fetching versions:', err);
          const friendlyMessage = handleError(err);
          setError(friendlyMessage);
          setLoading(false);
        }
      );

      return () => unsubscribe();
    } catch (err) {
      console.error('Error setting up versions listener:', err);
      const friendlyMessage = handleError(err);
      setError(friendlyMessage);
      setLoading(false);
    }
  }, []);

  // Fetch latest version metadata
  useEffect(() => {
    if (!db) return;

    try {
      const latestRef = doc(db, 'installer_metadata', 'latest');

      const unsubscribe = onSnapshot(
        latestRef,
        (doc) => {
          if (doc.exists()) {
            setLatestVersion({
              id: 'latest',
              ...doc.data(),
            } as InstallerVersion);
          }
        },
        (err) => {
          console.error('Error fetching latest version:', err);
        }
      );

      return () => unsubscribe();
    } catch (err) {
      console.error('Error setting up latest version listener:', err);
    }
  }, []);

  /**
   * Upload a new installer version
   *
   * @param file - The installer .exe file
   * @param version - Version number (e.g., "2.0.0")
   * @param releaseNotes - Optional release notes
   * @param setAsLatest - Whether to set this as the latest version
   * @param onProgress - Progress callback (0-100)
   */
  const uploadVersion = useCallback(
    async (
      file: File,
      version: string,
      releaseNotes: string | undefined,
      setAsLatest: boolean,
      onProgress?: (progress: number) => void
    ): Promise<void> => {
      if (!db) {
        throw new Error('Firebase is not configured');
      }

      if (!user) {
        throw new Error('You must be logged in to upload');
      }

      try {
        // Upload to Firebase Storage
        const { downloadUrl, checksum, fileSize } = await uploadInstaller(
          file,
          version,
          onProgress
        );

        // Create metadata document
        const versionData: Partial<Omit<InstallerVersion, 'id'>> = {
          version,
          download_url: downloadUrl,
          file_size: fileSize,
          release_date: Timestamp.now(),
          checksum_sha256: checksum,
          uploaded_by: user.email || user.uid,
        };

        // Only add release_notes if it's not undefined
        if (releaseNotes !== undefined) {
          versionData.release_notes = releaseNotes;
        }

        // Save to versions collection
        const versionRef = doc(db, 'installer_metadata', 'data', 'versions', version);
        await setDoc(versionRef, versionData);

        // If set as latest, also update the latest document
        if (setAsLatest) {
          const latestRef = doc(db, 'installer_metadata', 'latest');
          await setDoc(latestRef, versionData);
        }
      } catch (err) {
        console.error('Error uploading version:', err);
        throw new Error(handleError(err));
      }
    },
    [user]
  );

  /**
   * Set a version as the latest
   *
   * @param version - The version to set as latest
   */
  const setAsLatest = useCallback(
    async (version: string): Promise<void> => {
      if (!db) {
        throw new Error('Firebase is not configured');
      }

      try {
        // Find the version data
        const versionData = versions.find((v) => v.version === version);
        if (!versionData) {
          throw new Error('Version not found');
        }

        // Update the /latest document
        const latestRef = doc(db, 'installer_metadata', 'latest');
        const latestData: any = {
          version: versionData.version,
          download_url: versionData.download_url,
          file_size: versionData.file_size,
          release_date: versionData.release_date,
          checksum_sha256: versionData.checksum_sha256,
          uploaded_by: versionData.uploaded_by,
        };

        // Only include release_notes if it exists
        if (versionData.release_notes !== undefined) {
          latestData.release_notes = versionData.release_notes;
        }

        await setDoc(latestRef, latestData);
      } catch (err) {
        console.error('Error setting latest version:', err);
        throw new Error(handleError(err));
      }
    },
    [versions]
  );

  /**
   * Delete an installer version
   *
   * @param version - The version to delete
   */
  const deleteVersion = useCallback(async (version: string): Promise<void> => {
    if (!db) {
      throw new Error('Firebase is not configured');
    }

    try {
      // Delete from Firebase Storage
      await deleteInstallerVersion(version);

      // Delete metadata document
      const versionRef = doc(db, 'installer_metadata', 'data', 'versions', version);
      await deleteDoc(versionRef);
    } catch (err) {
      console.error('Error deleting version:', err);
      throw new Error(handleError(err));
    }
  }, []);

  /**
   * Identify versions eligible for cleanup.
   * Keeps: latest patch per minor series, anything uploaded within retentionDays, and the current latest.
   */
  const getCleanupCandidates = useCallback(
    (retentionDays: number = 30): InstallerVersion[] => {
      if (!latestVersion) return [];

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - retentionDays);

      // Group versions by major.minor
      const groups = new Map<string, InstallerVersion[]>();
      for (const v of versions) {
        const parts = v.version.split('.');
        if (parts.length !== 3) continue;
        const key = `${parts[0]}.${parts[1]}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(v);
      }

      // Find the highest patch per minor group
      const keepVersions = new Set<string>();
      keepVersions.add(latestVersion.version);

      for (const [, group] of groups) {
        let highest = group[0];
        for (const v of group) {
          const patchA = parseInt(v.version.split('.')[2], 10);
          const patchB = parseInt(highest.version.split('.')[2], 10);
          if (patchA > patchB) highest = v;
        }
        keepVersions.add(highest.version);
      }

      return versions.filter((v) => {
        if (keepVersions.has(v.version)) return false;
        // Keep if uploaded within retention window
        const uploadDate = v.release_date?.toDate
          ? v.release_date.toDate()
          : new Date(v.release_date as any);
        if (uploadDate > cutoff) return false;
        return true;
      });
    },
    [versions, latestVersion]
  );

  /**
   * Delete all cleanup candidate versions
   */
  const cleanupVersions = useCallback(
    async (candidates: InstallerVersion[]): Promise<number> => {
      let deleted = 0;
      for (const v of candidates) {
        await deleteVersion(v.version);
        deleted++;
      }
      return deleted;
    },
    [deleteVersion]
  );

  return {
    versions,
    latestVersion,
    loading,
    error,
    uploadVersion,
    setAsLatest,
    deleteVersion,
    getCleanupCandidates,
    cleanupVersions,
  };
}
