'use client';

/**
 * Real-time listener over `sites/{siteId}/roosts/{roostId}` — one doc per deploy
 * target (current version pointer + metadata). Authoritative for /roost;
 * v1 `project_distributions` is legacy.
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
  /** Written by the publish transaction; `undefined` on roosts not redeployed since. */
  totalFiles?: number;
  totalSize?: number;
  createdAt: FirestoreTs;
  updatedAt?: FirestoreTs;
  createdBy?: string;
}

/** Stable identity for the not-loaded case, so consumers' deps don't churn. */
const EMPTY_ROOSTS: Roost[] = [];

export function useRoosts(siteId: string) {
  // `loading` is DERIVED from "this site not delivered yet", not latched: a
  // latched useState(true) never cleared with no siteId to subscribe to, so a
  // caller with no sites spun forever. Deriving keeps the flicker guarantee too.
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
          // DELETE is a soft delete (`deletedAt` + `tombstoneExpiresAt`), so
          // filter here to make the row disappear before gc reaps the doc.
          .filter((d) => !d.data()?.deletedAt)
          .map((d) => {
          const x = d.data();
          // Legacy roosts predate the manifest→version rename: read
          // `currentManifestId` and imply v1 so re-sync, copy-id and file-list
          // expand keep working until a backfill ships.
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
        // Pin loadedSiteId: the error ends the subscription, so leaving it null
        // would hold consumers in `loading` instead of rendering the error.
        setState({ roosts: [], loadedSiteId: siteId, error: err.message });
      },
    );
    return () => unsub();
  }, [siteId]);

  const loaded = !!siteId && state.loadedSiteId === siteId;
  const roosts = loaded ? state.roosts : EMPTY_ROOSTS;
  const loading = !!db && !!siteId && !loaded;
  // Scoped to the site in view so one site's permission failure can't leak.
  const error = !db ? 'Firebase not configured' : loaded ? state.error : null;

  return { roosts, loading, error };
}
