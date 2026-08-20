'use client';

import { useSyncExternalStore } from 'react';

import {
  ESCAPE_MARKER_PARAM,
  detectInAppBrowser,
  type InAppBrowserInfo,
} from '@/lib/inAppBrowser';

export interface InAppBrowserState extends InAppBrowserInfo {
  /** Page load carries the escape marker: the one-tap "open in <browser>" did
   *  nothing, so show the manual instructions. */
  escapeAttempted: boolean;
}

const SERVER_STATE: InAppBrowserState = Object.freeze({
  isInApp: false,
  escapeAttempted: false,
});

/** Nothing to subscribe to (the environment is fixed per document); identity must
 *  be stable or React re-subscribes every commit. */
const subscribe = () => () => {};

/**
 * `getSnapshot` must be referentially stable or React re-renders forever, so the
 * result is memoised — keyed on the query string, because the escape marker (unlike
 * the user-agent) differs between /login and /register and a single global cache
 * would leak one page's marker into the other on client-side navigation.
 */
let cache: { search: string; value: InAppBrowserState } | null = null;

function getSnapshot(): InAppBrowserState {
  const search = window.location.search;
  if (cache && cache.search === search) return cache.value;

  let escapeAttempted = false;
  try {
    escapeAttempted = new URLSearchParams(search).has(ESCAPE_MARKER_PARAM);
  } catch {
    // A malformed query string is not worth failing over.
  }

  const value: InAppBrowserState = { ...detectInAppBrowser(), escapeAttempted };
  cache = { search, value };
  return value;
}

function getServerSnapshot(): InAppBrowserState {
  return SERVER_STATE;
}

/**
 * Identify the host app when running inside an embedded webview.
 *
 * `useSyncExternalStore`, not an effect: a render-time `navigator.userAgent` read
 * causes a hydration mismatch, and React's recovery (discard SSR tree, re-render)
 * has swallowed clicks here before — see the `canUsePasskey` comment in
 * app/login/page.tsx, where it hangs the e2e suite. The server snapshot being
 * first-class also spares ordinary visitors a cascading render.
 */
export function useInAppBrowser(): InAppBrowserState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
