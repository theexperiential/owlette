'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { useAuth } from '@/contexts/AuthContext';

export interface RedirectIfAuthenticatedOptions {
  /**
   * Where to send them. Defaults to /dashboard, matching the proxy's own
   * fallback. /login passes its validated `redirect` param so the two agree.
   */
  target?: string;
  /**
   * True while the calling page is itself signing someone in: `signUp()` /
   * `signInWithPopup()` populate `user` before the caller has resolved where to
   * send them, so the redirect would beat that navigation and drop a new signup
   * on /dashboard instead of /setup-2fa.
   */
  skip?: boolean;
}

/**
 * Bounce an already-signed-in user off an auth page (/login, /register).
 *
 * proxy.ts has this rule, but only sees requests that reach the server: a
 * client-side history pop replays from the App Router cache with no round trip.
 * That gap put a freshly-registered user who cancelled /setup-2fa back on a
 * blank signup form, where re-submitting gave auth/email-already-in-use with no
 * way forward (OWLETTE-WEB-46).
 *
 * A UX hint only — it does not re-derive the proxy's MFA branch; the target is
 * protected and proxy.ts remains the authority.
 */
export function useRedirectIfAuthenticated({
  target = '/dashboard',
  skip = false,
}: RedirectIfAuthenticatedOptions = {}): void {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (skip || loading || !user) return;
    // replace, not push — a page they should never have seen shouldn't be in the
    // back-button history.
    router.replace(target);
  }, [skip, loading, user, target, router]);
}
