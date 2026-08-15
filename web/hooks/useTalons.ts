'use client';

/**
 * useTalons — real-time listener for `sites/{siteId}/talons`.
 *
 * Read-only on purpose. Every talon mutation goes through
 * `/api/sites/{siteId}/talons` so validation, the `command`-output privilege
 * gate, the webhook SSRF check, and the audit emit can't be sidestepped (see
 * `@/lib/talons/store.server`), and firestore.rules 2.7.0 denies client writes
 * to this collection outright. Site members may read it, which is what makes
 * the live subscription below possible.
 */

import { useEffect, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { TalonDoc } from '@/lib/talons/types';

/**
 * A talon document plus the id its collection keys it by — the client-side
 * mirror of `StoredTalon` in `@/lib/talons/store.server`, which can't be
 * imported here because that module pulls in firebase-admin.
 */
export interface Talon extends TalonDoc {
  id: string;
}

// Module-level constant so the "not loaded for this site" branch returns the
// same reference on every render and can't churn consumers' memo/effect deps.
const EMPTY_TALONS: Talon[] = [];

export function useTalons(siteId: string) {
  // loadedSiteId pins state to the site it was populated for so `loading` can
  // be derived at render without a synchronous reset on site change — that
  // reset is what makes empty states flicker.
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
            // Sorted on below, so it has to be a string even if a document
            // somehow reaches the client without one.
            name: typeof data.name === 'string' ? data.name : '',
          });
        });

        // Sorted client-side rather than with an `orderBy('name')`, matching
        // `listTalons` on the server: a Firestore orderBy silently drops
        // documents that lack the field, and a name-less talon must still be
        // visible (and fixable) in the list.
        talonData.sort((a, b) => a.name.localeCompare(b.name));

        setState({ talons: talonData, loadedSiteId: siteId, error: null });
      },
      (err) => {
        console.error('Error fetching talons:', err);
        // Pin loadedSiteId on the error path too: onSnapshot's error callback
        // ends the subscription, so leaving it null would hold consumers in
        // `loading` forever instead of letting them render the error.
        setState({ talons: [], loadedSiteId: siteId, error: err.message });
      },
    );

    return () => unsubscribe();
  }, [siteId]);

  const loaded = !!siteId && state.loadedSiteId === siteId;
  const talons = loaded ? state.talons : EMPTY_TALONS;
  const loading = !!db && !!siteId && !loaded;
  // An error is only ever reported for the site currently in view, so one
  // site's permission failure can't leak onto the next.
  const error = !db ? 'Firebase not configured' : (loaded ? state.error : null);

  return { talons, loading, error };
}
