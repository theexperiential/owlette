'use client';

/**
 * UX NUDGE, NOT ENFORCEMENT — real enforcement is server-side (see lib/securityVersion.ts).
 *
 * Non-dismissible banner shown when the server's `x-security-version` is newer than the one
 * baked into the loaded bundle. No close affordance on purpose: the only remediation is a
 * reload that fetches the new bundle. Rendered from the root layout, and returns null until a
 * mismatch is seen, so there's no SSR cost or layout shift in the common case.
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
