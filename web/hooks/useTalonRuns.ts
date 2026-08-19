'use client';

/**
 * useTalonRuns — real-time listener for one talon's execution history at
 * `sites/{siteId}/talon_runs`, newest first.
 *
 * Read-only: run records are an audit surface written solely by the runner
 * (admin SDK), and firestore.rules 2.7.0 denies every client write while
 * allowing site members to read. Backed by the `(talonId ASC, startedAt DESC)`
 * composite index in firestore.indexes.json — the orderBy is required, not
 * cosmetic: without it Firestore would slice `limit` off a document-id-ordered
 * set, and run ids are random.
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
 * Milliseconds from any shape a `TalonTimestamp` can arrive in. Mirrors
 * `firestoreTsToMs` in `./useFirestore`, which types its input as the
 * client-SDK `FirestoreTs` union and so can't accept a `TalonTimestamp`
 * directly. Returns 0 for absent / unparseable values, which sorts them last.
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
 * @param talonId  `null` disables the hook entirely — no listener is opened
 *                 and the result is an empty, non-loading list. That is the
 *                 state a run panel sits in before a talon is selected.
 */
export function useTalonRuns(
  siteId: string,
  talonId: string | null,
  limitCount: number = DEFAULT_RUN_LIMIT,
) {
  // Same pinning trick as useTalons, widened to the (site, talon) pair the
  // listener is for: `loading` is derived from a key mismatch instead of being
  // reset synchronously when the selected talon changes. `limitCount` is
  // deliberately NOT part of the key — widening the window re-subscribes, but
  // the already-rendered runs stay valid rather than flashing back to a
  // skeleton.
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

        // The query already orders these; re-sorting keeps the newest-first
        // contract even for cache-served snapshots, which can surface a
        // pending local write before the server assigns its timestamp.
        runData.sort((a, b) => talonTsToMs(b.startedAt) - talonTsToMs(a.startedAt));

        setState({ runs: runData, loadedKey: requestedKey, error: null });
      },
      (err) => {
        console.error('Error fetching talon runs:', err);
        // Pinned on the error path for the same reason as useTalons: the
        // subscription is over, so consumers must leave `loading`.
        setState({ runs: [], loadedKey: requestedKey, error: err.message });
      },
    );

    return () => unsubscribe();
  }, [siteId, talonId, limitCount, requestedKey]);

  const loaded = requestedKey !== null && state.loadedKey === requestedKey;
  const runs = loaded ? state.runs : EMPTY_RUNS;
  const loading = requestedKey !== null && !loaded;
  // Scoped to the talon in view, so an error from a previously selected talon
  // can't linger once the selection changes or clears.
  const error = !db ? 'Firebase not configured' : (loaded ? state.error : null);

  return { runs, loading, error };
}
