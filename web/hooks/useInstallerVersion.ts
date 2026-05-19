'use client';

import { useState, useEffect } from 'react';
import { doc, onSnapshot, Timestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { handleError } from '@/lib/errorHandler';

export interface InstallerVersionInfo {
  version: string;
  downloadUrl: string;
  fileSize: number;
  releaseDate: Timestamp;
  releaseNotes?: string;
}

/**
 * useInstallerVersion Hook
 *
 * Public hook for fetching the latest installer version.
 * Used by the download button in the dashboard header.
 *
 * Features:
 * - Real-time updates when new version is uploaded
 * - Returns latest version metadata
 * - Available to all authenticated users
 *
 * Usage:
 * const { version, downloadUrl, fileSize, isLoading } = useInstallerVersion();
 */
export function useInstallerVersion() {
  const [versionInfo, setVersionInfo] = useState<InstallerVersionInfo | null>(null);
  const [loading, setLoading] = useState(!!db);
  const [error, setError] = useState<string | null>(db ? null : 'Firebase is not configured');

  useEffect(() => {
    if (!db) return;

    // `doc()` only throws on invalid path segments (both literal here) and
    // onSnapshot surfaces runtime listener errors through its error callback —
    // no sync try/catch needed, and avoids the react-hooks/set-state-in-effect
    // violation that a sync catch-block setState would trigger.
    const latestRef = doc(db, 'installer_metadata', 'latest');

    const unsubscribe = onSnapshot(
      latestRef,
      (doc) => {
        if (doc.exists()) {
          const data = doc.data();
          setVersionInfo({
            version: data.version,
            downloadUrl: data.download_url,
            fileSize: data.file_size,
            releaseDate: data.release_date,
            releaseNotes: data.release_notes,
          });
          setError(null);
        } else {
          setError('No installer version available');
        }
        setLoading(false);
      },
      (err) => {
        console.error('Error fetching installer version:', err);
        const friendlyMessage = handleError(err);
        setError(friendlyMessage);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, []);

  return {
    version: versionInfo?.version,
    downloadUrl: versionInfo?.downloadUrl,
    fileSize: versionInfo?.fileSize,
    releaseDate: versionInfo?.releaseDate,
    releaseNotes: versionInfo?.releaseNotes,
    isLoading: loading,
    error,
  };
}
