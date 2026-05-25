'use client';

/**
 * Subscribe to a site's tier-3 Cortex approval policy
 * (`sites/{siteId}/settings/cortex.requireTier3Approval`).
 *
 * Defaults to `true` (gate on) when the doc/field is absent or unreadable,
 * mirroring the server-side `getCortexRequireTier3Approval` default — so the
 * UI shows the safe state until (and if) the snapshot says otherwise.
 */

import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';

export function useCortexApprovalSetting(siteId: string) {
  const [requireApproval, setRequireApproval] = useState(true);

  useEffect(() => {
    if (!siteId || !db) return;
    const ref = doc(db, 'sites', siteId, 'settings', 'cortex');
    const unsub = onSnapshot(
      ref,
      (snap) => setRequireApproval(snap.data()?.requireTier3Approval !== false),
      (error) => {
        console.error('Failed to read cortex approval setting:', error);
        setRequireApproval(true);
      },
    );
    return () => unsub();
  }, [siteId]);

  return { requireApproval };
}
