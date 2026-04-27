'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  collection,
  query,
  onSnapshot,
  doc,
  orderBy,
  Timestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { handleError } from '@/lib/errorHandler';
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
        const uploadInit = await fetch('/api/installer/upload', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'Idempotency-Key': createIdempotencyKey(`installer-upload-start-${version}`),
          },
          body: JSON.stringify({
            version,
            fileName: file.name,
            contentType: file.type || 'application/octet-stream',
            releaseNotes,
            setAsLatest,
          }),
        });
        if (!uploadInit.ok) throw new Error(await readApiError(uploadInit, 'Failed to start upload'));
        const uploadBody = await uploadInit.json();

        await uploadFileToSignedUrl(uploadBody.uploadUrl, file, onProgress);

        const finalize = await fetch('/api/installer/upload', {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            'Idempotency-Key': createIdempotencyKey(`installer-upload-finalize-${uploadBody.uploadId}`),
          },
          body: JSON.stringify({ uploadId: uploadBody.uploadId }),
        });
        if (!finalize.ok) throw new Error(await readApiError(finalize, 'Failed to finalize upload'));
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
        const response = await fetch(`/api/installer/${encodeURIComponent(version)}/set-latest`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'Idempotency-Key': createIdempotencyKey(`installer-set-latest-${version}`),
          },
          body: JSON.stringify({}),
        });
        if (!response.ok) throw new Error(await readApiError(response, 'Failed to set latest version'));
      } catch (err) {
        console.error('Error setting latest version:', err);
        throw new Error(handleError(err));
      }
    },
    []
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
      const response = await fetch(`/api/installer/${encodeURIComponent(version)}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error(await readApiError(response, 'Failed to delete installer version'));
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
        // Keep if uploaded within retention window. release_date is typed as
        // Timestamp but can arrive as other shapes from cache rehydration /
        // legacy writes — narrow structurally and fall through to new Date().
        const rd = v.release_date as
          | { toDate?: () => Date }
          | number
          | string
          | Date
          | null
          | undefined;
        const uploadDate = rd && typeof (rd as { toDate?: () => Date }).toDate === 'function'
          ? (rd as { toDate: () => Date }).toDate()
          : new Date(rd as number | string | Date);
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

function uploadFileToSignedUrl(
  uploadUrl: string,
  file: File,
  onProgress?: (progress: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100);
        resolve();
      } else {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.send(file);
  });
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    return body.detail ?? body.title ?? body.error ?? `${fallback} (${response.status})`;
  } catch {
    return `${fallback} (${response.status})`;
  }
}

function createIdempotencyKey(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}
