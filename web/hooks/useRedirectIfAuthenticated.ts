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
   * Pass true while the calling page is itself signing someone in. `signUp()`
   * and `signInWithPopup()` populate `user` well before the caller has resolved
   * where to send them, and without this the redirect below would beat that
   * navigation to the punch — sending a brand-new signup to /dashboard instead
   * of /setup-2fa.
   */
  skip?: boolean;
}

/**
 * Bounce an already-signed-in user off an auth page (/login, /register).
 *
 * proxy.ts has this rule already — see its `pathname === '/login' ||
 * pathname === '/register'` branch — but it only ever sees requests that reach
 * the server. A client-side history pop does not: the App Router replays the
 * entry straight out of its router cache with no round trip, so the proxy is
 * never consulted. That gap is how a freshly-registered user who hit "cancel"
 * on /setup-2fa landed back on a blank signup form, concluded the signup had
 * not taken, filled it in again, and got auth/email-already-in-use with no way
 * forward (OWLETTE-WEB-46).
 *
 * This deliberately does not try to re-derive the proxy's MFA branch client
 * side: the target is protected, so the proxy and the dashboard's own 2FA guard
 * route onward from there. It is a UX hint. proxy.ts remains the authority.
 */
export function useRedirectIfAuthenticated({
  target = '/dashboard',
  skip = false,
}: RedirectIfAuthenticatedOptions = {}): void {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (skip || loading || !user) return;
    // replace, not push: a page they should never have been shown does not
    // belong in the history their back button walks.
    router.replace(target);
  }, [skip, loading, user, target, router]);
}
