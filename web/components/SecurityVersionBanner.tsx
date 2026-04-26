'use client';

/**
 * SecurityVersionBanner
 *
 * !! THIS IS UX, NOT SAFETY !!
 *
 * Renders a non-dismissible top banner when the server reports a
 * `x-security-version` newer than the one baked into the loaded bundle.
 * Intentionally has no close affordance — the only remediation is a real
 * page reload, which fetches the new bundle. Hiding the banner without
 * reloading would defeat the entire point of nudging stale tabs.
 *
 * The banner is rendered from the root layout so it sits above every
 * page. It returns `null` until a mismatch is detected, so there's no
 * SSR cost and no layout shift in the common case.
 *
 * Real security enforcement lives server-side; this component is purely
 * a UX nudge. See `lib/securityVersion.ts` for the rationale.
 */

import { useSecurityVersion } from '@/hooks/useSecurityVersion';

function reload() {
  if (typeof window !== 'undefined') {
    window.location.reload();
  }
}

export function SecurityVersionBanner() {
  const stale = useSecurityVersion();
  if (!stale) return null;
  return (
    <div
      role="alert"
      aria-live="polite"
      data-testid="security-version-banner"
      className="fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-3 border-b border-border bg-secondary/95 px-4 py-2 text-sm text-foreground shadow-lg backdrop-blur-sm"
    >
      <span>a security update is available. reload to continue.</span>
      <button
        type="button"
        onClick={reload}
        data-testid="security-version-banner-reload"
        className="inline-flex items-center rounded-md bg-accent-cyan px-3 py-1 text-xs font-semibold text-background transition-colors hover:bg-accent-cyan-hover"
      >
        reload
      </button>
    </div>
  );
}
