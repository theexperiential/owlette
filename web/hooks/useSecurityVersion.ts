'use client';

/**
 * UX, NOT SAFETY. Watches the proxy's `x-security-version` header on every
 * `/api/*` response and latches a flag when it disagrees with the bundle's
 * `CURRENT_SECURITY_VERSION`, driving `SecurityVersionBanner`.
 *
 * `window.fetch` is monkey-patched once, guarded by a module flag so remounts
 * and fast-refresh can't stack interceptors. Reading `Headers` doesn't consume
 * the body, so no clone is needed. Latching is one-way — only a page reload,
 * which loads the new bundle, clears it.
 */

import { useSyncExternalStore } from 'react';
import { CURRENT_SECURITY_VERSION, SECURITY_VERSION_HEADER } from '@/lib/securityVersion';

let mismatchDetected = false;
let interceptorInstalled = false;
const subscribers = new Set<() => void>();

function notify() {
  subscribers.forEach((fn) => fn());
}

function checkResponse(response: Response) {
  if (mismatchDetected) return;
  const raw = response.headers.get(SECURITY_VERSION_HEADER);
  if (raw === null) return;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return;
  if (parsed !== CURRENT_SECURITY_VERSION) {
    mismatchDetected = true;
    notify();
  }
}

function installInterceptor() {
  if (interceptorInstalled) return;
  if (typeof window === 'undefined') return;
  if (typeof window.fetch !== 'function') return;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const response = await originalFetch(...args);
    try {
      checkResponse(response);
    } catch {
      // Header inspection must never break the underlying request.
    }
    return response;
  };
  interceptorInstalled = true;
}

function subscribe(notifyFn: () => void) {
  subscribers.add(notifyFn);
  installInterceptor();
  return () => {
    subscribers.delete(notifyFn);
  };
}

function getSnapshot(): boolean {
  return mismatchDetected;
}

function getServerSnapshot(): boolean {
  return false;
}

/** True once any `/api/*` response disagrees with the bundle's version. */
export function useSecurityVersion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Test-only module-state reset. Clears the interceptor flag too, so each
 * test's fresh `window.fetch` mock gets re-wrapped.
 */
export function __resetSecurityVersionForTests(): void {
  mismatchDetected = false;
  subscribers.clear();
  interceptorInstalled = false;
}
