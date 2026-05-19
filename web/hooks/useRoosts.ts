'use client';

/**
 * useRoosts — real-time listener for the v2 roost collection.
 * Reads `sites/{siteId}/roosts/{roostId}` docs, which each
 * represent one deploy target (current version pointer + metadata).
 * Per clean-cutover, this is the authoritative source for the /roost
 * page. v1 `project_distributions` is legacy.
 */

import { useEffect, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { firestoreTsToMs, type FirestoreTs } from './useFirestore';

export interface Roost {
  /** Firestore doc id — also the canonical roostId in the upload flow. */
  id: string;
  name: string;
  schemaVersion: number;
  currentVersionId: string | null;
  /** Auto-incrementing per-roost version number on the current version. */
  currentVersionNumber: number | null;
  /** Plaintext description of the current version (≤500 chars). */
  currentVersionDescription: string | null;
  previousVersionId: string | null;
  versionUrl: string | null;
  /** Monotonic version counter on the roost doc — source of truth for next versionNumber. */
  versionCounter: number;
  extractPath?: string;
  targets: string[];
  /** Denormalised summary for the current version — populated by the
   *  publish transaction on new roosts. Legacy roosts (no publish since
   *  this field was added) will show `undefined` until next redeploy. */
  totalFiles?: number;
  totalSize?: number;
  createdAt: FirestoreTs;
  updatedAt?: FirestoreTs;
  createdBy?: string;
}

export function useRoosts(siteId: string) {
  const [roosts, setRoosts] = useState<Roost[]>([]);
  // Stay in `loading` until onSnapshot delivers its first batch. If
  // siteId hasn't resolved yet, we can't possibly know what's in
  // firestore — "not loading" with an empty list would let the page
  // flash the welcome/empty state before real data arrives.
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!db || !siteId) return;
    const ref = collection(db, 'sites', siteId, 'roosts');
    const unsub = onSnapshot(
      ref,
      (snap) => {
        const next: Roost[] = snap.docs
          // DELETE on /api/roosts/{id} is a soft delete — it stamps the
          // doc with `deletedAt` + `tombstoneExpiresAt` rather than
          // removing it. Filter those out client-side so the row
          // disappears immediately on delete; the back-end gc reaps the
          // doc once the tombstone expires.
          .filter((d) => !d.data()?.deletedAt)
          .map((d) => {
          const x = d.data();
          // Legacy roosts predate the manifest→version rename and still
          // store `currentManifestId` / no `currentVersionNumber`. Fall
          // back to those fields so re-sync, copy-id, and file-list
          // expand stay enabled until a backfill ships. Treat any roost
          // that has SOME version pointer as having an implicit v1 when
          // no number is recorded.
          const fallbackVersionId =
            (x.currentVersionId as string | null) ??
            (x.currentManifestId as string | null) ??
            null;
          const recordedVersionNumber =
            typeof x.currentVersionNumber === 'number' ? x.currentVersionNumber : null;
          return {
            id: d.id,
            name: typeof x.name === 'string' ? x.name : d.id,
            schemaVersion: typeof x.schemaVersion === 'number' ? x.schemaVersion : 2,
            currentVersionId: fallbackVersionId,
            currentVersionNumber:
              recordedVersionNumber ?? (fallbackVersionId ? 1 : null),
            currentVersionDescription:
              typeof x.currentVersionDescription === 'string'
                ? x.currentVersionDescription
                : null,
            previousVersionId: (x.previousVersionId as string | null) ?? null,
            versionUrl: (x.versionUrl as string | null) ?? null,
            versionCounter: typeof x.versionCounter === 'number' ? x.versionCounter : 0,
            extractPath: typeof x.extractPath === 'string' ? x.extractPath : undefined,
            targets: Array.isArray(x.targets) ? (x.targets as string[]) : [],
            totalFiles: typeof x.totalFiles === 'number' ? x.totalFiles : undefined,
            totalSize: typeof x.totalSize === 'number' ? x.totalSize : undefined,
            createdAt: x.createdAt ?? Date.now(),
            updatedAt: x.updatedAt,
            createdBy: typeof x.createdBy === 'string' ? x.createdBy : undefined,
          };
        });
        next.sort((a, b) => firestoreTsToMs(b.createdAt) - firestoreTsToMs(a.createdAt));
        setRoosts(next);
        setLoading(false);
      },
      (err) => {
        setError(err.message);
        setLoading(false);
      },
    );
    return () => unsub();
  }, [siteId]);

  return { roosts, loading, error };
}
