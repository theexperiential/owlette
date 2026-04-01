'use client';

import { useEffect, useState } from 'react';
import { collection, query, orderBy, limit, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';

export interface ScreenshotRecord {
  id: string;
  url: string;
  timestamp: number;
  sizeKB: number;
}

/**
 * Real-time listener for a machine's screenshot history subcollection.
 * Only activates when `enabled` is true (e.g., when gallery is open).
 */
export function useScreenshotHistory(
  siteId: string,
  machineId: string,
  enabled: boolean
) {
  const [screenshots, setScreenshots] = useState<ScreenshotRecord[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !db || !siteId || !machineId) {
      setScreenshots([]);
      return;
    }

    setLoading(true);

    const col = collection(db, 'sites', siteId, 'machines', machineId, 'screenshots');
    const q = query(col, orderBy('timestamp', 'desc'), limit(20));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const records: ScreenshotRecord[] = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...(doc.data() as Omit<ScreenshotRecord, 'id'>),
      }));
      setScreenshots(records);
      setLoading(false);
    }, (error) => {
      console.error('[useScreenshotHistory] Snapshot error:', error);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [enabled, siteId, machineId]);

  return { screenshots, loading };
}
