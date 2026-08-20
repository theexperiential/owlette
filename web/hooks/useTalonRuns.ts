'use client';

/**
 * Real-time listener for one talon's execution history at
 * `sites/{siteId}/talon_runs`, newest first.
 *
 * Read-only — runs are an audit surface written only by the runner, and
 * firestore.rules denies every client write. Backed by the
 * `(talonId ASC, startedAt DESC)` composite index; the orderBy is required, not
 * cosmetic: without it `limit` slices a document-id-ordered set, and run ids
 * are random.
 */

import { useEffect, useState } from 'react';
import { collection, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { TalonRunDoc, TalonTimestamp } from '@/lib/talons/types';

/** A run document plus the id its collection keys it by. */
export interface TalonRun extends TalonRunDoc {
  id: string;
}

/** Enough to fill a run-history panel without a second page. */
const DEFAULT_RUN_LIMIT = 20;

// Stable reference for the disabled / not-yet-loaded branches — see the note
// on EMPTY_TALONS in useTalons.
const EMPTY_RUNS: TalonRun[] = [];

/**
 * Milliseconds from any shape a `TalonTimestamp` arrives in. Mirrors
 * `firestoreTsToMs`, which types its input as the client-SDK `FirestoreTs`
 * union and can't take a `TalonTimestamp`. 0 for absent/unparseable — sorts last.
 */
function talonTsToMs(ts: TalonTimestamp | undefined): number {
  if (ts == null) return 0;
  if (typeof ts === 'number') return ts;
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const value = ts as { toMillis?: () => number; seconds?: number; _seconds?: number };
  if (typeof value.toMillis === 'function') {
    try {
      return value.toMillis();
    } catch {
      return 0;
    }
  }
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  if (typeof value._seconds === 'number') return value._seconds * 1000;
  return 0;
}

/**
 * @param talonId `null` opens no listener and yields an empty, non-loading
 *                list — the state a run panel sits in before a talon is picked.
 */
export function useTalonRuns(
  siteId: string,
  talonId: string | null,
  limitCount: number = DEFAULT_RUN_LIMIT,
) {
  // Same pinning as useTalons, keyed on (site, talon): `loading` derives from a
  // key mismatch rather than a synchronous reset. `limitCount` is deliberately
  // NOT in the key — widening the window re-subscribes without flashing a
  // skeleton over already-valid runs.
  const requestedKey = db && siteId && talonId ? `${siteId}/${talonId}` : null;

  const [state, setState] = useState<{
    runs: TalonRun[];
    loadedKey: string | null;
    error: string | null;
  }>({
    runs: [],
    loadedKey: null,
    error: null,
  });

  useEffect(() => {
    if (!db || !siteId || !talonId || !requestedKey) return;

    const runsRef = collection(db, 'sites', siteId, 'talon_runs');
    const runsQuery = query(
      runsRef,
      where('talonId', '==', talonId),
      orderBy('startedAt', 'desc'),
      limit(limitCount),
    );

    const unsubscribe = onSnapshot(
      runsQuery,
      (snapshot) => {
        const runData: TalonRun[] = snapshot.docs.map((docSnap) => ({
          ...(docSnap.data() as TalonRunDoc),
          id: docSnap.id,
        }));

        // Re-sorted despite the query's orderBy: cache-served snapshots can
        // surface a pending local write before the server timestamps it.
        runData.sort((a, b) => talonTsToMs(b.startedAt) - talonTsToMs(a.startedAt));

        setState({ runs: runData, loadedKey: requestedKey, error: null });
      },
      (err) => {
        console.error('Error fetching talon runs:', err);
        // Pinned on the error path too — the subscription is over, so consumers
        // must leave `loading`.
        setState({ runs: [], loadedKey: requestedKey, error: err.message });
      },
    );

    return () => unsubscribe();
  }, [siteId, talonId, limitCount, requestedKey]);

  const loaded = requestedKey !== null && state.loadedKey === requestedKey;
  const runs = loaded ? state.runs : EMPTY_RUNS;
  const loading = requestedKey !== null && !loaded;
  // Scoped to the talon in view so a stale error can't linger past a selection
  // change.
  const error = !db ? 'Firebase not configured' : (loaded ? state.error : null);

  return { runs, loading, error };
}
