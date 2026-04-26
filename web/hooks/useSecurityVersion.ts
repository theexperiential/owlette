'use client';

/**
 * useSecurityVersion Hook
 *
 * !! THIS IS UX, NOT SAFETY !!
 *
 * Watches every `fetch()` response on the client for the
 * `x-security-version` header (stamped by the proxy on every `/api/*`
 * response) and flips a global flag when the server's value disagrees
 * with the bundle's compiled-in `CURRENT_SECURITY_VERSION`. The flag
 * drives a non-dismissible reload banner — see `SecurityVersionBanner`.
 *
 * Implementation notes:
 *   - One-time monkey-patch of `window.fetch` on first hook mount. We
 *     guard with a module-level flag so re-mounts (and the Next.js
 *     dev-server fast-refresh) don't stack interceptors.
 *   - The interceptor only reads the header; it never mutates the
 *     response or its body. Cloning is unnecessary because `Headers`
 *     access does not consume the stream.
 *   - State is exposed via `useSyncExternalStore` so any number of
 *     components can subscribe (banner, telemetry, etc.) without
 *     duplicating fetch wrappers.
 *   - A mismatch is one-way latching: once detected, we never clear it.
 *     The only resolution is a real page reload, which loads the new
 *     bundle and resets the in-memory state.
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

/**
 * Returns `true` once any `/api/*` response reports a security version
 * different from the bundle's compiled-in `CURRENT_SECURITY_VERSION`.
 * Latches on first mismatch — only a real page reload clears it.
 */
export function useSecurityVersion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Test-only escape hatch for resetting module state between cases. Not
 * exported from any public surface — Jest reaches it via the module
 * import directly. Also clears the interceptor-installed flag so each
 * test's fresh `window.fetch` mock can be re-wrapped.
 */
export function __resetSecurityVersionForTests(): void {
  mismatchDetected = false;
  subscribers.clear();
  interceptorInstalled = false;
}
