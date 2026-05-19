'use client';

import { useEffect, useState } from 'react';
import { collection, query, orderBy, limit, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { FirestoreTs } from './useFirestore';

export interface ScreenshotRecord {
  id: string;
  url: string;
  timestamp: FirestoreTs;
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
  // loadedKey pins the snapshot data to the (siteId, machineId) it was fetched
  // for, so `loading` can be derived at render without a sync setState on key
  // change. Errors from the listener also land through the state setter.
  const [state, setState] = useState<{
    screenshots: ScreenshotRecord[];
    loadedKey: string | null;
  }>({ screenshots: [], loadedKey: null });

  const currentKey = enabled && db && siteId && machineId ? `${siteId}/${machineId}` : null;

  useEffect(() => {
    if (!currentKey || !db) return;

    const col = collection(db, 'sites', siteId, 'machines', machineId, 'screenshots');
    const q = query(col, orderBy('timestamp', 'desc'), limit(20));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const records: ScreenshotRecord[] = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...(doc.data() as Omit<ScreenshotRecord, 'id'>),
      }));
      setState({ screenshots: records, loadedKey: currentKey });
    }, (error) => {
      console.error('[useScreenshotHistory] Snapshot error:', error);
      // Mark as "loaded" so the spinner clears; consumers get an empty list.
      setState({ screenshots: [], loadedKey: currentKey });
    });

    return () => unsubscribe();
  }, [currentKey, siteId, machineId]);

  // Gate the returned list on key-match so stale data from a prior machine
  // never leaks, and derive loading without needing a sync setState.
  const screenshots = currentKey && state.loadedKey === currentKey ? state.screenshots : EMPTY_SCREENSHOTS;
  const loading = currentKey !== null && state.loadedKey !== currentKey;
  return { screenshots, loading };
}

/** Stable empty array so consumers' memo/effect deps don't churn. */
const EMPTY_SCREENSHOTS: ScreenshotRecord[] = [];
