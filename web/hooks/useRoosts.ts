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

/** Stable identity for the not-loaded case, so consumers' deps don't churn. */
const EMPTY_ROOSTS: Roost[] = [];

export function useRoosts(siteId: string) {
  // `loading` is derived from "the listener has not delivered THIS site yet"
  // rather than latched in state. A latched `useState(true)` never cleared
  // when there was no siteId to subscribe to, so a caller with no sites sat
  // on a spinner forever instead of being told it had none. Deriving it also
  // keeps the flicker guarantee the latch was there for: an unresolved siteId
  // still reads as loading, never as a real empty result.
  const [state, setState] = useState<{
    roosts: Roost[];
    loadedSiteId: string | null;
    error: string | null;
  }>({ roosts: [], loadedSiteId: null, error: null });

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
        setState({ roosts: next, loadedSiteId: siteId, error: null });
      },
      (err) => {
        // Pin loadedSiteId here too: the error callback ends the
        // subscription, so leaving it null would hold consumers in `loading`
        // forever instead of letting them render the error.
        setState({ roosts: [], loadedSiteId: siteId, error: err.message });
      },
    );
    return () => unsub();
  }, [siteId]);

  const loaded = !!siteId && state.loadedSiteId === siteId;
  const roosts = loaded ? state.roosts : EMPTY_ROOSTS;
  const loading = !!db && !!siteId && !loaded;
  // Only ever report an error for the site currently in view, so one site's
  // permission failure can't leak onto the next.
  const error = !db ? 'Firebase not configured' : loaded ? state.error : null;

  return { roosts, loading, error };
}
