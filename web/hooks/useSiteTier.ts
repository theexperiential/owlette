'use client';

/**
 * useSiteTier (api-sprint wave 3.2 — pro pricing tier substrate).
 *
 * Subscribes to a single site doc and resolves its effective tier through
 * `getSiteTier()`, applying the beta default for any site that hasn't yet
 * had `tier` written to its doc. Returns `undefined` while the listener is
 * still resolving so callers can render a loading state instead of flashing
 * the wrong gate decision.
 *
 * No Firestore writes — this hook only reads. Tier mutation belongs to the
 * billing flow (separate sprint), not the gated UI.
 */
import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { getSiteTier, type SiteTier } from '@/lib/siteTier';

interface TierState {
  /** siteId the loaded tier corresponds to. `null` = nothing loaded yet. */
  loadedSiteId: string | null;
  tier: SiteTier | undefined;
}

const INITIAL_STATE: TierState = { loadedSiteId: null, tier: undefined };

/**
 * Resolve the pricing tier for a single site.
 *
 * @param siteId — the site to subscribe to. When falsy (empty string,
 * undefined) the hook stays in its loading state and returns `undefined`,
 * matching the caller's loading-render branch.
 * @returns `'core' | 'pro'` once the doc has loaded, or `undefined` while
 * the listener resolves / when no `siteId` was supplied.
 */
export function useSiteTier(siteId: string | undefined): SiteTier | undefined {
  const [state, setState] = useState<TierState>(INITIAL_STATE);

  useEffect(() => {
    if (!db || !siteId) return;

    const ref = doc(db, 'sites', siteId);
    const unsubscribe = onSnapshot(
      ref,
      (snap) => {
        // Resolve via `getSiteTier`: the helper applies the beta default
        // for both missing docs and missing/unknown tier fields, so the
        // gate makes the same decision in either case.
        const data = snap.exists() ? (snap.data() ?? undefined) : undefined;
        setState({ loadedSiteId: siteId, tier: getSiteTier(data) });
      },
      () => {
        // Listener errors leave the previous resolved tier in place so
        // the consumer doesn't oscillate between gate states on transient
        // network blips. A subsequent successful snapshot will replace it.
      },
    );
    return () => unsubscribe();
  }, [siteId]);

  // Derive the result without setState-in-effect: only surface the cached
  // tier when it matches the requested siteId. A site swap therefore
  // returns `undefined` (loading) until the next snapshot lands, which is
  // exactly the contract callers depend on for not flashing the gate.
  if (!siteId) return undefined;
  return state.loadedSiteId === siteId ? state.tier : undefined;
}
