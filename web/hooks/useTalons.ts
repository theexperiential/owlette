'use client';

/**
 * Real-time listener for `sites/{siteId}/talons`. Read-only on purpose: every
 * mutation goes through `/api/sites/{siteId}/talons` so validation, the
 * `command`-output privilege gate, the webhook SSRF check and the audit emit
 * can't be sidestepped, and firestore.rules 2.7.0 denies client writes outright.
 */

import { useEffect, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { TalonDoc } from '@/lib/talons/types';

/** Client-side mirror of `StoredTalon`; that module can't be imported (firebase-admin). */
export interface Talon extends TalonDoc {
  id: string;
}

// Module-level so the "not loaded" branch returns a stable reference and can't
// churn consumers' memo/effect deps.
const EMPTY_TALONS: Talon[] = [];

export function useTalons(siteId: string) {
  // Pins state to the site it was populated for, so `loading` derives at render
  // instead of needing a sync reset on site change — that reset flickers empty states.
  const [state, setState] = useState<{
    talons: Talon[];
    loadedSiteId: string | null;
    error: string | null;
  }>({
    talons: [],
    loadedSiteId: null,
    error: null,
  });

  useEffect(() => {
    if (!db || !siteId) return;

    const talonsRef = collection(db, 'sites', siteId, 'talons');

    const unsubscribe = onSnapshot(
      talonsRef,
      (snapshot) => {
        const talonData: Talon[] = [];

        snapshot.forEach((docSnap) => {
          const data = docSnap.data() as TalonDoc;
          talonData.push({
            ...data,
            id: docSnap.id,
            // sorted on below, so it must be a string even if a doc lacks it
            name: typeof data.name === 'string' ? data.name : '',
          });
        });

        // Client-side, not orderBy('name') (matching server `listTalons`): Firestore
        // orderBy silently drops docs lacking the field, and a name-less talon must
        // stay visible to be fixable.
        talonData.sort((a, b) => a.name.localeCompare(b.name));

        setState({ talons: talonData, loadedSiteId: siteId, error: null });
      },
      (err) => {
        console.error('Error fetching talons:', err);
        // Also on the error path: onSnapshot's error ends the subscription, so a null
        // here would hold consumers in `loading` forever.
        setState({ talons: [], loadedSiteId: siteId, error: err.message });
      },
    );

    return () => unsubscribe();
  }, [siteId]);

  const loaded = !!siteId && state.loadedSiteId === siteId;
  const talons = loaded ? state.talons : EMPTY_TALONS;
  const loading = !!db && !!siteId && !loaded;
  // scoped to the site in view, so one site's permission failure can't leak onto the next
  const error = !db ? 'Firebase not configured' : (loaded ? state.error : null);

  return { talons, loading, error };
}
