'use client';

/**
 * Site-scoped page state: the visible site list plus the currently selected
 * site, in one place.
 *
 * Every site-scoped surface needs the same three things — which sites can I
 * see, which one am I looking at, and what do I render when the answer is
 * "none". That logic had been hand-rolled five times (dashboard, deployments,
 * logs, roosts, talons) and the copies disagreed: two derived the selection
 * during render, three synced it through an effect, and three treated "no site
 * selected" as indistinguishable from "still loading" — which is what made a
 * brand-new account sit on a spinner forever on /deployments, /logs and
 * /roosts instead of being told it had no sites.
 *
 * `hasNoSites` exists to make that distinction explicit at the call site, so a
 * page cannot accidentally collapse the two states again. Prefer it over
 * testing `!currentSiteId`, which is also true during the initial load.
 */

import { useCallback, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useSites, type Site } from '@/hooks/useFirestore';

export interface UseCurrentSiteResult {
  /** Sites the caller can see. Empty until the listener delivers. */
  sites: Site[];
  /** Selected site id, or `''` when nothing is selectable yet. */
  currentSiteId: string;
  /** The selected site document, when one is resolved. */
  currentSite: Site | undefined;
  /** IANA timezone of the selected site, for timestamp rendering. */
  siteTimezone: string | undefined;
  /** True while the site list is still resolving. */
  sitesLoading: boolean;
  /**
   * True once loading has settled and the caller has no sites at all.
   * Distinct from `!currentSiteId`, which is also true mid-load.
   */
  hasNoSites: boolean;
  /** Select a site and persist it as the caller's last site. */
  selectSite: (siteId: string) => void;
  /**
   * Select a site without persisting it. Used right after creation, where
   * the site is already the natural focus but the user has not chosen it as
   * their default.
   */
  pickSite: (siteId: string) => void;
  createSite: ReturnType<typeof useSites>['createSite'];
  updateSite: ReturnType<typeof useSites>['updateSite'];
  deleteSite: ReturnType<typeof useSites>['deleteSite'];
  checkSiteIdAvailability: ReturnType<typeof useSites>['checkSiteIdAvailability'];
  sitesError: string | null;
}

export function useCurrentSite(): UseCurrentSiteResult {
  const { user, userSites, isSuperadmin, lastSiteId, updateLastSite } = useAuth();
  const {
    sites,
    loading: sitesLoading,
    error: sitesError,
    createSite,
    updateSite,
    deleteSite,
    checkSiteIdAvailability,
  } = useSites(user?.uid, userSites, isSuperadmin);

  // Empty string means "no explicit pick yet — fall back to lastSiteId, then
  // localStorage, then the first accessible site".
  const [userPickedSiteId, setUserPickedSiteId] = useState<string>('');

  // Derived during render rather than synced through an effect, so a changing
  // site list cannot cascade re-renders (`react-hooks/set-state-in-effect`).
  const currentSiteId = useMemo(() => {
    if (userPickedSiteId && sites.some((s) => s.id === userPickedSiteId)) {
      return userPickedSiteId;
    }
    if (sitesLoading || sites.length === 0) return '';
    const savedSite =
      lastSiteId ||
      (typeof window !== 'undefined'
        ? localStorage.getItem('owlette_current_site')
        : null);
    if (savedSite && sites.some((s) => s.id === savedSite)) return savedSite;
    return sites[0].id;
  }, [userPickedSiteId, sites, sitesLoading, lastSiteId]);

  const currentSite = useMemo(
    () => sites.find((s) => s.id === currentSiteId),
    [sites, currentSiteId],
  );

  const selectSite = useCallback(
    (siteId: string) => {
      setUserPickedSiteId(siteId);
      updateLastSite(siteId);
    },
    [updateLastSite],
  );

  const pickSite = useCallback((siteId: string) => {
    setUserPickedSiteId(siteId);
  }, []);

  return {
    sites,
    currentSiteId,
    currentSite,
    siteTimezone: currentSite?.timezone,
    sitesLoading,
    hasNoSites: !sitesLoading && sites.length === 0,
    selectSite,
    pickSite,
    createSite,
    updateSite,
    deleteSite,
    checkSiteIdAvailability,
    sitesError,
  };
}
