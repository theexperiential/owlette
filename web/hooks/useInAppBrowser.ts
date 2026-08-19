'use client';

import { useSyncExternalStore } from 'react';

import {
  ESCAPE_MARKER_PARAM,
  detectInAppBrowser,
  type InAppBrowserInfo,
} from '@/lib/inAppBrowser';

export interface InAppBrowserState extends InAppBrowserInfo {
  /**
   * True when this page load carries the escape marker — i.e. the user already
   * tapped "open in <browser>" and is still here, so the one-tap shortcut did
   * nothing and the copy should go straight to the manual instructions.
   */
  escapeAttempted: boolean;
}

const SERVER_STATE: InAppBrowserState = Object.freeze({
  isInApp: false,
  escapeAttempted: false,
});

/**
 * The environment never changes within a document, so there is nothing to
 * subscribe to. Stable identity matters more than the body here — a new
 * function per render would make React re-subscribe on every commit.
 */
const subscribe = () => () => {};

/**
 * `getSnapshot` must return a referentially stable value between renders or
 * React re-renders forever, so the result is memoised.
 *
 * Keyed on the query string, not just computed once: the user-agent is fixed
 * for the life of the document, but the escape marker is not — /login and
 * /register carry it independently, so a single global cache would leak one
 * page's marker into the other after a client-side navigation.
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
 * Identify the host app when the page is running inside an embedded webview.
 *
 * Uses `useSyncExternalStore` rather than detecting in an effect. Both avoid
 * the hydration mismatch that a render-time `navigator.userAgent` read would
 * cause — and that mismatch is not theoretical on these pages: React recovers
 * by discarding the SSR tree and re-rendering, and an in-flight re-render here
 * has swallowed clicks before (see the `canUsePasskey` comment in
 * app/login/page.tsx, where it hangs the e2e suite). This is the better of the
 * two: the server snapshot is a first-class concept rather than an initial
 * state to be corrected, so ordinary visitors pay no cascading render.
 */
export function useInAppBrowser(): InAppBrowserState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
