'use client';

/**
 * useTargetStates — real-time listener for per-target sync status
 * reported by agents during a roost rollout.
 *
 * path: sites/{siteId}/roosts/{roostId}/target_state/{machineId}
 *
 * The `onTargetStateWritten` cloud function reads the same docs to
 * advance canary→fleet; the UI reads them to show per-target progress
 * on the roost page.
 *
 * Skipping the listener entirely when siteId / roostId aren't set
 * avoids a dangling collection ref and a spurious permission-denied.
 */

import { useEffect, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { firestoreTsToMs, type FirestoreTs } from './useFirestore';

export type TargetStatus =
  | 'pending'
  | 'downloading'
  | 'assembling'
  | 'committed'
  | 'failed'
  | 'cancelled';

export interface TargetState {
  /** Firestore doc id — the machineId this report is from. */
  machineId: string;
  reportedManifestId: string | null;
  status: TargetStatus | null;
  error?: string;
  chunksTotal?: number;
  chunksFetched?: number;
  chunksDedup?: number;
  filesTotal?: number;
  filesAssembled?: number;
  filesSkipped?: number;
  updatedAt: FirestoreTs | null;
}

function coerceStatus(raw: unknown): TargetStatus | null {
  if (typeof raw !== 'string') return null;
  switch (raw) {
    case 'pending':
    case 'downloading':
    case 'assembling':
    case 'committed':
    case 'failed':
    case 'cancelled':
      return raw;
    default:
      return null;
  }
}

export function useTargetStates(siteId: string, roostId: string | null) {
  const [states, setStates] = useState<TargetState[]>([]);
  // Start in loading state only when we have a path to listen on. When
  // siteId / roostId are empty we're genuinely "not loading" — there's
  // nothing to wait for. Computing this during render avoids a cascading
  // setState({}) + setLoading(false) inside the effect.
  const initialLoading = !!(siteId && roostId);
  const [loading, setLoading] = useState<boolean>(initialLoading);

  useEffect(() => {
    if (!db || !siteId || !roostId) {
      return;
    }
    const ref = collection(db, 'sites', siteId, 'roosts', roostId, 'target_state');
    const unsub = onSnapshot(
      ref,
      (snap) => {
        const next: TargetState[] = snap.docs.map((d) => {
          const x = d.data() as Record<string, unknown>;
          return {
            machineId: d.id,
            reportedManifestId:
              typeof x.reportedManifestId === 'string' ? x.reportedManifestId : null,
            status: coerceStatus(x.status),
            error: typeof x.error === 'string' ? x.error : undefined,
            chunksTotal: typeof x.chunks_total === 'number' ? x.chunks_total : undefined,
            chunksFetched: typeof x.chunks_fetched === 'number' ? x.chunks_fetched : undefined,
            chunksDedup: typeof x.chunks_dedup === 'number' ? x.chunks_dedup : undefined,
            filesTotal: typeof x.files_total === 'number' ? x.files_total : undefined,
            filesAssembled: typeof x.files_assembled === 'number' ? x.files_assembled : undefined,
            filesSkipped: typeof x.files_skipped === 'number' ? x.files_skipped : undefined,
            updatedAt: (x.updatedAt as FirestoreTs | undefined) ?? null,
          };
        });
        next.sort((a, b) => firestoreTsToMs(b.updatedAt) - firestoreTsToMs(a.updatedAt));
        setStates(next);
        setLoading(false);
      },
      () => {
        // Permission-denied happens legitimately during site-switch races.
        // Blank the list and drop the loading flag; the page-level roosts
        // listener handles surfacing hard auth errors.
        setStates([]);
        setLoading(false);
      },
    );
    return () => unsub();
  }, [siteId, roostId]);

  return { states, loading };
}
