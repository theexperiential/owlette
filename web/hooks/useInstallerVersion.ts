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
 * Latest installer version, live via onSnapshot. Backs the dashboard header's
 * download button; readable by any authenticated user.
 */
export function useInstallerVersion() {
  const [versionInfo, setVersionInfo] = useState<InstallerVersionInfo | null>(null);
  const [loading, setLoading] = useState(!!db);
  const [error, setError] = useState<string | null>(db ? null : 'Firebase is not configured');

  useEffect(() => {
    if (!db) return;

    // No try/catch: `doc()` only throws on invalid path segments (both literal
    // here) and onSnapshot reports runtime errors through its error callback. A
    // sync catch-block setState would trip react-hooks/set-state-in-effect.
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
