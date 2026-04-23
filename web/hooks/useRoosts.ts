'use client';

/**
 * useRoosts — real-time listener for the v2 roost collection.
 * Reads `sites/{siteId}/roosts/{roostId}` docs, which each
 * represent one deploy target (current manifest pointer + metadata).
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
  currentManifestId: string | null;
  previousManifestId: string | null;
  manifestUrl: string | null;
  extractPath?: string;
  targets: string[];
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
        const next: Roost[] = snap.docs.map((d) => {
          const x = d.data();
          return {
            id: d.id,
            name: typeof x.name === 'string' ? x.name : d.id,
            schemaVersion: typeof x.schemaVersion === 'number' ? x.schemaVersion : 2,
            currentManifestId: (x.currentManifestId as string | null) ?? null,
            previousManifestId: (x.previousManifestId as string | null) ?? null,
            manifestUrl: (x.manifestUrl as string | null) ?? null,
            extractPath: typeof x.extractPath === 'string' ? x.extractPath : undefined,
            targets: Array.isArray(x.targets) ? (x.targets as string[]) : [],
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
