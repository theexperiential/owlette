'use client';

import { Suspense, useCallback, useRef, useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Fingerprint } from 'lucide-react';
import { toast } from '@/lib/toast';
import { sanitizeError } from '@/lib/errorHandler';
import { isPopupUnavailableError } from '@/lib/inAppBrowser';
import { resolvePostSignInPath } from '@/lib/postSignIn';
import { signInWithCustomToken } from 'firebase/auth';
import { OwletteEyeIcon } from '@/components/landing/OwletteEye';
import { auth as firebaseAuth } from '@/lib/firebase';
import {
  WebAuthnAbortService,
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  startAuthentication,
} from '@simplewebauthn/browser';
import { LoadingWord } from '@/components/LoadingWord';
import { FormError } from '@/components/ui/form-error';
import { InAppBrowserNotice } from '@/components/InAppBrowserNotice';
import { useFieldError } from '@/hooks/useFieldError';
import { useInAppBrowser } from '@/hooks/useInAppBrowser';
import { useRedirectIfAuthenticated } from '@/hooks/useRedirectIfAuthenticated';

/**
 * A `redirect` param is only usable if it is a same-origin relative path —
 * `//evil.example` is protocol-relative and would leave the site.
 */
const safeRedirect = (value: string | null): string | null =>
  value && value.startsWith('/') && !value.startsWith('//') ? value : null;

/**
 * The wire half of a passkey sign-in — options, ceremony, verify, Firebase
 * session — shared by the explicit "continue with passkey" button and the
 * conditional-UI (autofill) ceremony below. The two differ only in HOW the
 * credential is chosen, so sharing this keeps them from drifting apart.
 *
 * Deliberately at module scope rather than a closure over component state: the
 * conditional ceremony is started once and can stay pending for the whole life
 * of the page, and an effect depending on a per-render closure would tear that
 * pending ceremony down and restart it on every commit.
 *
 * Resolves true once a Firebase session exists, false when `isCurrent` retired
 * the run before the authenticator was ever touched. Everything else throws for
 * the caller to classify — the two callers grade failures very differently.
 */
async function runPasskeyCeremony({
  useBrowserAutofill = false,
  onCredential,
  isCurrent,
}: {
  useBrowserAutofill?: boolean;
  /**
   * Fires in the gap between the user committing a credential and the server
   * round-trip — the moment a passive autofill prompt becomes a sign-in in
   * progress.
   */
  onCredential?: () => void;
  /** Polled before the ceremony starts; false retires the run silently. */
  isCurrent?: () => boolean;
} = {}): Promise<boolean> {
  // Step 1: Get authentication options
  const optionsRes = await fetch('/api/passkeys/authenticate/options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });

  if (!optionsRes.ok) {
    throw new Error('Failed to get authentication options');
  }

  const { options, challengeId } = await optionsRes.json();

  // That was a real network hop, and a conditional run can be retired during
  // it (unmount, or strict mode's second pass). Bail before touching the
  // authenticator rather than leaving a ceremony pending — under client-side
  // routing the document survives the navigation, so a stray conditional
  // ceremony would follow the user onto the next page.
  if (isCurrent && !isCurrent()) {
    return false;
  }

  // Step 2: Start WebAuthn authentication. Without `useBrowserAutofill` this is
  // the browser's modal prompt; with it the credential is offered inside the
  // browser's own autofill dropdown and the promise sits pending — possibly for
  // the whole visit — until the user picks one or something aborts it.
  const credential = await startAuthentication({ optionsJSON: options, useBrowserAutofill });
  onCredential?.();

  // Step 3: Verify with server
  const verifyRes = await fetch('/api/passkeys/authenticate/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential, challengeId }),
  });

  if (!verifyRes.ok) {
    const data = await verifyRes.json();
    throw new Error(data.error || 'Passkey authentication failed');
  }

  const { customToken } = await verifyRes.json();

  // Step 4: Sign in with Firebase custom token
  if (firebaseAuth) {
    await signInWithCustomToken(firebaseAuth, customToken);
  }

  return true;
}

function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  /**
   * Progressive disclosure for the email path, mirroring /register. Collapsed
   * by default so Google and passkey are the only buttons on first paint and
   * therefore carry the visual weight; latches open on first email focus and
   * never closes, so a partly-filled form can't collapse mid-entry.
   */
  const [emailFormOpen, setEmailFormOpen] = useState(false);
  /** Field-targeted validation — see hooks/useFieldError.ts. */
  const { error: formError, fail, clear: clearError, fieldProps } = useFieldError('login-form-error');
  const [redirectUrl, setRedirectUrl] = useState('/dashboard');
  // WebAuthn support can only be detected client-side (browserSupportsWebAuthn
  // reads window.PublicKeyCredential). Calling it during render makes the
  // passkey button render server-side=absent / client-side=present, which is a
  // hydration mismatch (React #418 — recoverable, but it discards the SSR tree
  // and re-renders, and in the E2E harness the in-flight re-render drops the
  // login click so the suite hangs on /login). Gate on a mounted flag so the
  // first client render matches the server (no button), then reveal it after
  // hydration.
  const [canUsePasskey, setCanUsePasskey] = useState(false);
  /**
   * Whether this browser can offer passkeys inside its own autofill dropdown
   * (conditional UI). A separate — and asynchronous — question from WebAuthn
   * support, since `isConditionalMediationAvailable()` returns a promise, but
   * resolved the same hydration-safe way as `canUsePasskey`: never during
   * render, so the server and the first client render agree.
   */
  const [canAutofillPasskey, setCanAutofillPasskey] = useState(false);
  /**
   * Set when Google sign-in fails because the browser refused the popup. Covers
   * the webviews the user-agent doesn't identify, plus ordinary browsers with a
   * popup blocker — so the remediation appears even when detection said no.
   */
  const [popupBlocked, setPopupBlocked] = useState(false);
  /**
   * Latched once a sign-in starts here, so the guard below cannot pre-empt the
   * navigation these handlers are already resolving. A ref, not `loading`:
   * `loading` is cleared in their `finally`, which runs while the push is still
   * in flight — and that push may be to /verify-2fa, not the guard's target.
   */
  const authInFlight = useRef(false);
  /**
   * Identity of the conditional-UI ceremony currently pending, or null when
   * there is none. Doubles as the concurrency guard — a second simultaneous
   * conditional `navigator.credentials.get()` is an error — and is cleared by
   * whichever of cleanup, cancel, or the run settling happens first.
   */
  const conditionalRun = useRef<symbol | null>(null);
  const { signIn, signInWithGoogle } = useAuth();
  const inApp = useInAppBrowser();
  const router = useRouter();
  const searchParams = useSearchParams();

  /**
   * Google is unavailable — either we recognised the host app before the user
   * spent a tap on it, or the popup was refused when they did.
   */
  const googleUnavailable = inApp.isInApp || popupBlocked;
  /**
   * Passkeys are gated on the host app, NOT on `googleUnavailable`. A blocked
   * popup in ordinary Safari says nothing about WebAuthn — but inside an
   * embedded webview the ceremony can only use passkeys for the HOST app's
   * associated domain, and LinkedIn will never declare owlette.app as one. So
   * `browserSupportsWebAuthn()` returns true there while the ceremony is
   * guaranteed to fail. https://passkeys.dev/docs/reference/ios/
   */
  const showPasskey = canUsePasskey && !inApp.isInApp;
  /** "or" only earns its place while a non-email option is still on screen. */
  const showDivider = !googleUnavailable || showPasskey;
  /**
   * Force the email path open once Google is out, rather than leaving the
   * fallback we're pointing at collapsed behind a focus gesture. Applies even
   * when passkey survives — it may simply not be enrolled on this account.
   */
  const emailExpanded = emailFormOpen || googleUnavailable;

  useEffect(() => {
    setCanUsePasskey(browserSupportsWebAuthn());
  }, []);

  useEffect(() => {
    let active = true;
    browserSupportsWebAuthnAutofill()
      .then((supported) => {
        if (active) setCanAutofillPasskey(supported);
      })
      .catch(() => {
        // A probe that fails is a browser that cannot do conditional UI. Stay
        // quiet: the explicit passkey button still covers this user.
      });
    return () => {
      active = false;
    };
  }, []);

  // Read redirect parameter from URL (validated: must be a safe relative path)
  useEffect(() => {
    const redirect = safeRedirect(searchParams.get('redirect'));
    if (redirect) {
      setRedirectUrl(redirect);
    }
  }, [searchParams]);

  // Where to land after sign-in now lives in lib/postSignIn, shared with
  // /register. It used to be a local helper here, which is precisely why
  // /register never got it and raced the session cookie on every Google
  // signup — see the module comment.
  const checkMfaAndRedirect = (settleMs?: number) =>
    resolvePostSignInPath(redirectUrl, settleMs);

  // Already signed in? Then this form can only waste their time. Mirrors the
  // proxy rule, which a client-side history pop never reaches.
  //
  // Reads the param directly rather than using the `redirectUrl` state above:
  // effects flush in declaration order within a commit, so the guard would fire
  // once against the '/dashboard' default before setRedirectUrl had landed, and
  // a signed-in visitor to /login?redirect=%2Froost would end up on the
  // dashboard instead of where they asked to go.
  useRedirectIfAuthenticated({
    target: safeRedirect(searchParams.get('redirect')) ?? '/dashboard',
    skip: authInFlight.current,
  });

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();

    // Ours now that the form is noValidate — the native bubble no longer
    // covers these, and it never matched the rest of the UI anyway.
    if (!email.trim()) {
      return fail('email', 'enter your email address');
    }
    if (!password) {
      return fail('password', 'enter your password');
    }

    authInFlight.current = true;
    setLoading(true);

    try {
      await signIn(email, password);

      // Settles for the session cookie, then polls — see lib/postSignIn.
      const redirectPath = await checkMfaAndRedirect();

      if (redirectPath.includes('/verify-2fa')) {
        toast.info('2FA verification required');
      } else {
        toast.success('logged in successfully!');
      }

      router.push(redirectPath);
    } catch (error) {
      // Nobody was signed in, so re-arm the guard: this page stays mounted, and
      // the session could still change under it (signing in from another tab).
      authInFlight.current = false;
      toast.error(sanitizeError(error));
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    const alreadyBlocked = googleUnavailable;
    authInFlight.current = true;
    setLoading(true);

    try {
      await signInWithGoogle();

      // Settles for the session cookie, then polls — see lib/postSignIn.
      const redirectPath = await checkMfaAndRedirect();

      if (redirectPath.includes('/verify-2fa')) {
        toast.info('2FA verification required');
      } else {
        toast.success('logged in with Google!');
      }

      router.push(redirectPath);
    } catch (error) {
      // Nobody was signed in — re-arm the guard. See the email path above.
      authInFlight.current = false;
      // A refused popup is not a transient failure to be re-tried — it is an
      // environment that cannot do federated sign-in at all. Swap in the
      // inline remediation instead of a toast that expires with no next step.
      if (isPopupUnavailableError(error)) {
        setPopupBlocked(true);
        // If the notice was already on screen, the user got here via "try
        // google anyway" — nothing visible would change, so say so explicitly.
        if (alreadyBlocked) {
          toast.error('google sign-in is still blocked in this browser');
        }
      } else {
        toast.error(sanitizeError(error));
      }
    } finally {
      setLoading(false);
    }
  };

  /**
   * Where both passkey paths land once a session exists.
   *
   * The passkey verify route already minted a server-side session, and it
   * minted that session MFA-satisfied: the verify runs with
   * `requireUserVerification: true`, so it passes `mfaSatisfiedBy: 'passkey-uv'`
   * to `createSession`. A user who also has TOTP enrolled therefore keeps
   * `mfaRequired: true` but is born `mfaVerified: true` — one user-verified
   * ceremony covers both factors, so the proxy does not send them to
   * /verify-2fa. The redirect below still asks the SERVER where to go; nothing
   * here decides the gate client-side.
   */
  const finishPasskeySignIn = async () => {
    toast.success('signed in with passkey!');
    // No settle: the verify route above already minted the session cookie
    // before returning, so waiting would be dead latency.
    const redirectPath = await checkMfaAndRedirect(0);
    router.push(redirectPath);
  };

  /**
   * Retire the pending conditional-UI ceremony, if this page still owns one.
   *
   * Silent by construction — the abort surfaces to the run below as an
   * `AbortError`, which it does not report. Guarded on our own run still being
   * the live one because `WebAuthnAbortService` is a global singleton: without
   * that check this could cancel a ceremony the explicit button had started.
   *
   * Reads only refs and the singleton, so the empty dependency list is honest
   * and the identity stays stable — which is what lets the effect below use it
   * as a cleanup without being torn down and restarted on every render.
   */
  const cancelConditionalPasskey = useCallback(() => {
    if (!conditionalRun.current) return;
    conditionalRun.current = null;
    WebAuthnAbortService.cancelCeremony();
  }, []);

  const handlePasskeyLogin = async () => {
    authInFlight.current = true;
    setLoading(true);

    try {
      await runPasskeyCeremony();
      await finishPasskeySignIn();
    } catch (error) {
      // Nobody was signed in — re-arm the guard. See the email path above.
      authInFlight.current = false;
      if (error instanceof Error && error.name === 'NotAllowedError') {
        toast.error('passkey authentication was cancelled');
      } else {
        toast.error(sanitizeError(error));
      }
    } finally {
      setLoading(false);
    }
  };

  /**
   * The conditional ceremony below is started once and can stay pending for the
   * whole life of the page, so it must not resolve through the closure it was
   * started with: `redirectUrl` can still move under it (a client-side
   * navigation to /login?redirect=…). Park the current tail in a ref that every
   * commit refreshes. Having the effect depend on the closure instead is not an
   * option — that would cancel and restart the ceremony on every render.
   */
  const finishPasskeySignInRef = useRef(finishPasskeySignIn);
  useEffect(() => {
    finishPasskeySignInRef.current = finishPasskeySignIn;
  });

  /**
   * WebAuthn conditional UI: offer this user's passkey inside the browser's own
   * autofill dropdown when they focus the email field, no button press needed.
   * The ceremony has to be pending BEFORE the field is focused for the browser
   * to have anything to offer, so it starts on mount.
   *
   * Three things make it unlike the button path above:
   *
   *  1. It must not latch `authInFlight` or `loading`. This ceremony is
   *     long-lived — it sits pending until the user picks a credential or the
   *     page goes away — so latching either up front would disable the email
   *     and password fields for the entire visit and permanently suppress the
   *     already-signed-in guard. Both are latched from `onCredential` instead:
   *     the instant the user commits a credential, which is the first moment
   *     this stops being passive and becomes a sign-in in progress.
   *  2. Nothing here toasts a ceremony failure. A prompt the user ignored,
   *     dismissed, or navigated away from is not an error — they never asked
   *     for it. Only a failure AFTER a credential is committed is reported,
   *     because by then the user did choose a passkey and is owed an answer.
   *  3. It is gated on `showPasskey`, so the in-app-webview exclusion applies
   *     exactly as it does to the button: an embedded webview can only speak
   *     for the host app's relying party, so the ceremony cannot succeed there.
   *
   * One ceremony per visit: if it ends without signing anyone in, it is not
   * restarted. The explicit button is the retry.
   */
  useEffect(() => {
    if (!showPasskey || !canAutofillPasskey) return;
    // Two concurrent conditional ceremonies throw, and React strict mode runs
    // this effect twice in development. The guard is the run token rather than
    // a "has ever started" flag on purpose: the cleanup clears the token, so
    // strict mode's second pass starts a fresh ceremony instead of being
    // blocked into a state where none is pending at all.
    if (conditionalRun.current) return;

    const run = Symbol('conditional-passkey');
    conditionalRun.current = run;
    /** Set once the user picks a credential — see note 1 above. */
    let committed = false;

    void (async () => {
      try {
        const signedIn = await runPasskeyCeremony({
          useBrowserAutofill: true,
          isCurrent: () => conditionalRun.current === run,
          onCredential: () => {
            committed = true;
            authInFlight.current = true;
            setLoading(true);
          },
        });
        if (signedIn) {
          await finishPasskeySignInRef.current();
        }
      } catch (error) {
        if (!committed) {
          // Cancelled, aborted, superseded by the explicit button, or the
          // options request failed while nobody was watching. All silent by
          // design — the user did not ask for this ceremony, and the button
          // is still on screen either way.
          return;
        }
        // Past the point of no return: undo exactly what `onCredential`
        // latched, then say what went wrong.
        authInFlight.current = false;
        setLoading(false);
        toast.error(sanitizeError(error));
      } finally {
        if (conditionalRun.current === run) conditionalRun.current = null;
      }
    })();

    return cancelConditionalPasskey;
  }, [showPasskey, canAutofillPasskey, cancelConditionalPasskey]);

  return (
    <div className="relative flex min-h-screen items-center justify-center p-4 pb-32">
      {/* Grid background */}
      <div className="absolute inset-0 dot-grid opacity-30" />
      <div className="absolute inset-0 blueprint-grid opacity-15" />
      {/* Mirrors /register: brand on the left from md up, controls on the
          right, stacking to one column below md. */}
      <Card className="relative z-10 w-full max-w-md overflow-hidden border-border bg-card p-0 md:max-w-4xl">
        <div className="grid md:grid-cols-2">
          {/* Brand panel = hero, not a second grey. Same fill as the form
              column — near-identical flat fills sharing an edge read as a
              mistake — so the difference is carried by KIND instead of degree:
              the brand dot-grid texture plus a radial vignette easing to
              --card-recessed at the corners. The column border remains the
              single boundary encoding. */}
          <CardHeader className="relative flex flex-col items-center justify-center space-y-4 p-8 text-center md:h-full md:border-r md:border-border">
            <div className="dot-grid absolute inset-0 -z-10 opacity-25" aria-hidden="true" />
            <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(120%_120%_at_50%_50%,transparent_35%,var(--card-recessed)_100%)]" aria-hidden="true" />
            <OwletteEyeIcon size={80} />
            <div className="space-y-1">
              <CardTitle className="text-2xl font-bold text-foreground">owlette</CardTitle>
              <CardDescription className="text-muted-foreground">
                keep your installation running
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-6 bg-card p-8">
            {/* Passwordless first. Google and passkey are one group of
                alternatives, so they sit tight together while space-y-6
                separates them from the email form. */}
            <div className="space-y-2">
              {googleUnavailable ? (
                /* Google swapped out where the browser can't run it. The notice
                   carries its own "try google anyway", so nothing is removed —
                   detection only reorders and explains. */
                <InAppBrowserNotice
                  isInApp={inApp.isInApp}
                  appName={inApp.appName}
                  escapeAttempted={inApp.escapeAttempted}
                  onTryAnyway={handleGoogleLogin}
                  tryAnywayDisabled={loading}
                />
              ) : (
              <Button
                type="button"
                variant="outline"
                className="w-full cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={handleGoogleLogin}
                disabled={loading}
              >
                <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24">
                  <path
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    fill="#4285F4"
                  />
                  <path
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    fill="#34A853"
                  />
                  <path
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                    fill="#FBBC05"
                  />
                  <path
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                    fill="#EA4335"
                  />
                </svg>
                continue with Google
              </Button>
              )}

              {showPasskey && (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={handlePasskeyLogin}
                  disabled={loading}
                >
                  <Fingerprint className="mr-2 h-4 w-4" />
                  continue with passkey
                </Button>
              )}
            </div>

            {/* "or" only earns its place while a non-email option is still on
                screen — with Google and passkey both out, the email form is
                the path, not an alternative to one. */}
            {showDivider && (
              /* -mx-8 cancels CardContent's p-8 so the rule runs edge to edge of
                  the column instead of floating inset. Card is overflow-hidden,
                  so the bleed can't create a horizontal scrollbar. */
              <div className="relative -mx-8">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">
                    or
                  </span>
                </div>
              </div>
            )}

            <form onSubmit={handleEmailLogin} className="space-y-5" noValidate>
              <div className="space-y-2">
                <Label htmlFor="email" className="text-foreground">email</Label>
                <Input
                  id="email"
                  {...fieldProps('email')}
                  type="email"
                  // "webauthn" as the last token is what lets the browser list
                  // passkeys in this field's own autofill dropdown; it rides
                  // alongside a normal token so ordinary email autofill and
                  // password managers still behave.
                  autoComplete="username webauthn"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  // Focus (not click) so keyboard tabbing expands it too.
                  // e2e global-setup fills email before password, and fill()
                  // focuses first, so this opens the form for the suite too.
                  onFocus={() => setEmailFormOpen(true)}
                  required
                  disabled={loading}
                  className="bg-input border-border text-foreground placeholder:text-muted-foreground"
                />
              </div>

              {emailExpanded && (
                <div className="form-reveal">
                  <div className="space-y-5">
                  <div className="space-y-2">
                    <Label htmlFor="password" className="text-foreground">password</Label>
                    <Input
                      id="password"
                  {...fieldProps('password')}
                      type="password"
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        // They have chosen the password path, so the pending
                        // autofill ceremony is retired rather than left
                        // dangling behind the form they are typing into.
                        cancelConditionalPasskey();
                      }}
                      required
                      disabled={loading}
                      className="bg-input border-border text-foreground placeholder:text-muted-foreground"
                    />
                  </div>
                  <FormError message={formError?.message} id="login-form-error" />
                  <Button type="submit" className="w-full text-background font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed" disabled={loading}>
                    {loading ? 'signing in...' : 'sign in with email'}
                  </Button>
                  </div>
                </div>
              )}
            </form>

            {/* Full-bleed band: -mx-8/-mb-8 cancel CardContent's p-8 on three
                sides so this owns its own spacing, then symmetric py-6 centers
                the text within the band. Relying on the card's bottom padding
                instead left 24px above the text and 32px below it, which read
                as visually low. */}
            {/* Hairline only — the fill experiment is retired. One signal per
                boundary: the border plus symmetric py-6 does the separating. */}
            <div className="-mx-8 -mb-8 text-balance border-t border-border px-8 py-6 text-center text-sm text-muted-foreground">
              <a href="/forgot-password" className="whitespace-nowrap font-medium hl-link text-accent-cyan">
                forgot password?
              </a>
              <span className="px-2 text-border" aria-hidden="true">·</span>
              don&apos;t have an account?{' '}
              <a href="/register" className="whitespace-nowrap font-medium hl-link text-accent-cyan">
                sign up
              </a>
            </div>
          </CardContent>
        </div>
      </Card>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="relative flex min-h-screen items-center justify-center p-4 pb-32">
        {/* Grid background */}
        <div className="absolute inset-0 dot-grid opacity-30" />
        <div className="absolute inset-0 blueprint-grid opacity-15" />
        {/* Same two-column shell as the loaded form, so the card doesn't
            change shape when the suspense boundary resolves. */}
        <Card className="relative z-10 w-full max-w-md overflow-hidden border-border bg-card p-0 md:max-w-4xl">
          <div className="grid md:grid-cols-2">
            <CardHeader className="relative flex flex-col items-center justify-center space-y-4 p-8 text-center md:h-full md:border-r md:border-border">
              <div className="dot-grid absolute inset-0 -z-10 opacity-25" aria-hidden="true" />
              <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(120%_120%_at_50%_50%,transparent_35%,var(--card-recessed)_100%)]" aria-hidden="true" />
              <OwletteEyeIcon size={80} />
              <div className="space-y-1">
                <CardTitle className="text-2xl font-bold text-foreground">owlette</CardTitle>
                <CardDescription className="text-muted-foreground">
                  keep your installation running
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="flex items-center justify-center p-8">
              <div className="text-center text-muted-foreground"><LoadingWord /></div>
            </CardContent>
          </div>
        </Card>
      </div>
    }>
      <LoginForm />
    </Suspense>
  );
}
