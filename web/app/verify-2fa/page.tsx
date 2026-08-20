'use client';

import { useState, useEffect, useSyncExternalStore, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { OwletteEyeIcon } from '@/components/landing/OwletteEye';
import { Fingerprint } from 'lucide-react';
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { useInAppBrowser } from '@/hooks/useInAppBrowser';
import { toast } from '@/lib/toast';

/**
 * `browserSupportsWebAuthn()` reads `window.PublicKeyCredential`, so it can only
 * be answered on the client. Reading it during render would make the passkey
 * button server-absent / client-present — a hydration mismatch React recovers
 * from by discarding the SSR tree and re-rendering, which has swallowed clicks
 * on these auth pages before (see the `canUsePasskey` comment in
 * app/login/page.tsx).
 *
 * Resolved through `useSyncExternalStore` rather than a mounted flag set in an
 * effect, matching `useInAppBrowser`: the server snapshot is a first-class value
 * instead of an initial state to be corrected, so ordinary visitors pay no
 * cascading render. The environment cannot change within a document, so there
 * is nothing to subscribe to; the snapshot is a primitive and therefore already
 * referentially stable between renders.
 */
const subscribeWebAuthnSupport = () => () => {};
const getWebAuthnSupport = () => browserSupportsWebAuthn();
const getWebAuthnSupportOnServer = () => false;

function Verify2FAContent() {
  const { user, loading, signOut } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  // Accept both `redirect` (new contract, set by proxy + login page) and
  // `return` (historical contract from pre-Wave-2 callers). Either way
  // the value must be a same-origin relative path or we fall back to
  // /dashboard to avoid open-redirect issues.
  const rawReturn = searchParams.get('redirect') ?? searchParams.get('return') ?? '/dashboard';
  const returnUrl = (rawReturn.startsWith('/') && !rawReturn.startsWith('//')) ? rawReturn : '/dashboard';

  const [verificationCode, setVerificationCode] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [trustThisDevice, setTrustThisDevice] = useState(false);
  const [, setMfaReady] = useState(false);
  const canUsePasskey = useSyncExternalStore(
    subscribeWebAuthnSupport,
    getWebAuthnSupport,
    getWebAuthnSupportOnServer
  );
  const [isPasskeyPending, setIsPasskeyPending] = useState(false);
  const inApp = useInAppBrowser();
  /**
   * Passkeys are additionally gated on the host app: inside an embedded webview
   * the ceremony can only use passkeys for the HOST app's associated domain, so
   * `browserSupportsWebAuthn()` returns true while the prompt is guaranteed to
   * fail. Hiding it here is safe because the TOTP and backup-code paths below
   * are always rendered — this option is never the only way off this page.
   */
  const showPasskey = canUsePasskey && !inApp.isInApp;

  useEffect(() => {
    if (!loading && !user) {
      router.push('/login');
      return;
    }

    // Check if user has MFA enrolled. The proxy already gates this page
    // — an unverified, MFA-required session is the only thing it lets
    // through to /verify-2fa for an authenticated user — but we re-check
    // client-side to render the right copy and to handle the corner
    // case where the user landed here without an MFA challenge active
    // (e.g. clicked a stale bookmark after disabling MFA).
    if (user && db) {
      const userDocRef = doc(db, 'users', user.uid);
      getDoc(userDocRef)
        .then((docSnap) => {
          if (docSnap.exists()) {
            const userData = docSnap.data();

            // If MFA not enrolled, redirect to dashboard
            if (!userData.mfaEnrolled) {
              router.push(returnUrl);
              return;
            }

            setMfaReady(true);
          } else {
            // No user document, redirect to dashboard
            router.push(returnUrl);
          }
        })
        .catch((error) => {
          console.error('Error loading MFA configuration:', error);
          toast.error('Failed to load 2FA configuration');
        });
    }
  }, [user, loading, router, returnUrl]);

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!verificationCode) {
      toast.error('Please enter a verification code');
      return;
    }

    if (!useBackupCode && verificationCode.length !== 6) {
      toast.error('Please enter a 6-digit code');
      return;
    }

    if (!user) {
      toast.error('User not authenticated');
      return;
    }

    setIsSubmitting(true);

    try {
      // Verify code via server-side API (secret never sent to client)
      const response = await fetch('/api/mfa/verify-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.uid,
          code: verificationCode,
          isBackupCode: useBackupCode,
          trustDevice: trustThisDevice,
        }),
      });

      const data = await response.json();

      if (!response.ok || data.error) {
        toast.error(data.error || 'Invalid code', {
          description: useBackupCode
            ? 'The backup code you entered is incorrect.'
            : 'Please check your authenticator app and try again.',
        });
        setIsSubmitting(false);
        setVerificationCode('');
        return;
      }

      // Show backup code usage message if applicable
      if (data.backupCodeUsed) {
        toast.success('Backup code used', {
          description: 'This backup code has been removed.',
        });
      }

      // Server-side authority: /api/mfa/verify-login already flipped the
      // session cookie to mfaVerified=true. No client-side flag needed
      // for the proxy to allow the next navigation.

      // The "trust this device" checkbox is now server-authoritative: when
      // checked, /api/mfa/verify-login mints an HTTPOnly device-trust cookie
      // (consumed at session creation) and reports deviceTrusted=true. Only
      // claim the device was trusted when the server actually did so.
      if (data.deviceTrusted) {
        toast.success('Verification Successful', {
          description: 'This device has been trusted for 30 days.',
        });
      } else {
        toast.success('Verification Successful', {
          description: 'Redirecting...',
        });
      }

      // Redirect to return URL
      router.push(returnUrl);
    } catch (error) {
      console.error('Error verifying 2FA:', error);
      toast.error('Verification failed');
      setIsSubmitting(false);
    }
  };

  /**
   * Third challenge option: satisfy the gate with a passkey the user already
   * owns, instead of a TOTP code or a backup code.
   *
   * This runs against `/api/passkeys/step-up/*`, NOT the `/authenticate/*`
   * routes /login uses. The caller here is already signed in, so the step-up
   * routes require a session, scope the ceremony to that session's own uid, and
   * flip the session's MFA gate — they never mint a session or a Firebase
   * custom token. Nothing needs signing in again afterwards, so unlike the
   * login flow there is no `signInWithCustomToken` step.
   *
   * The "trust this device" checkbox belongs to the code form below and is not
   * read here: only `/api/mfa/verify-login` mints the device-trust cookie.
   */
  const handlePasskeyStepUp = async () => {
    if (!user) {
      toast.error('user not authenticated');
      return;
    }

    setIsPasskeyPending(true);

    try {
      // Step 1: options, scoped server-side to this session's own credentials.
      const optionsRes = await fetch('/api/passkeys/step-up/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const optionsData = await optionsRes.json();

      if (!optionsRes.ok) {
        toast.error(
          optionsData.code === 'no_passkeys'
            ? 'no passkeys are registered on this account'
            : 'could not start the passkey prompt',
          {
            description: 'use your authenticator app or a backup code instead.',
          }
        );
        setIsPasskeyPending(false);
        return;
      }

      // Step 2: browser prompt (PIN/biometric — the server demands `uv`).
      const credential = await startAuthentication({ optionsJSON: optionsData.options });

      // Step 3: verify. On success the session cookie is already
      // mfaVerified=true by the time this resolves, so the proxy will let the
      // next navigation through.
      const verifyRes = await fetch('/api/passkeys/step-up/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential, challengeId: optionsData.challengeId }),
      });

      if (!verifyRes.ok) {
        toast.error('passkey verification failed', {
          description: 'please try again, or use your authenticator app.',
        });
        setIsPasskeyPending(false);
        return;
      }

      toast.success('verification successful', {
        description: 'redirecting...',
      });
      router.push(returnUrl);
    } catch (error) {
      // A cancelled or timed-out prompt is a user action, not a fault — say so
      // plainly rather than surfacing the raw DOMException.
      if (error instanceof Error && error.name === 'NotAllowedError') {
        toast.error('passkey prompt was cancelled');
      } else {
        console.error('Error verifying passkey step-up:', error);
        toast.error('passkey verification failed');
      }
      setIsPasskeyPending(false);
    }
  };

  const handleCancel = async () => {
    await signOut();
    router.push('/login');
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p>loading...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative">
      {/* Grid background */}
      <div className="absolute inset-0 dot-grid opacity-30" />
      <div className="absolute inset-0 blueprint-grid opacity-15" />
      <Card className="relative z-10 w-full max-w-md border-border bg-card">
        <CardHeader className="space-y-4 flex flex-col items-center">
          <OwletteEyeIcon size={80} />
          <div className="space-y-1 text-center">
            <CardTitle className="text-2xl font-bold text-foreground">two-factor authentication</CardTitle>
            <CardDescription className="text-muted-foreground">
              {useBackupCode
                ? 'enter one of your backup codes'
                : 'enter the code from your authenticator app'}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {/* Passkey sits ABOVE the code form, mirroring /login's ordering, so
              the "trust this device" checkbox reads as belonging to the code
              path it actually applies to. Hidden entirely in an embedded
              webview or a browser without WebAuthn — the form below is always
              rendered, so hiding this never strands the user. */}
          {showPasskey && (
            <div className="mb-6 space-y-6">
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={handlePasskeyStepUp}
                disabled={isSubmitting || isPasskeyPending}
              >
                <Fingerprint className="mr-2 h-4 w-4" />
                {isPasskeyPending ? 'waiting for passkey...' : 'use a passkey'}
              </Button>

              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">or</span>
                </div>
              </div>
            </div>
          )}

          <form onSubmit={handleVerify} className="space-y-6">
            <div className="space-y-2">
              <Input
                type="text"
                name="otp"
                autoComplete="one-time-code"
                inputMode={useBackupCode ? 'text' : 'numeric'}
                placeholder={useBackupCode ? 'Backup Code' : '000000'}
                value={verificationCode}
                onChange={(e) => {
                  const value = useBackupCode
                    ? e.target.value.toUpperCase()
                    : e.target.value.replace(/\D/g, '').slice(0, 6);
                  setVerificationCode(value);
                }}
                maxLength={useBackupCode ? 16 : 6}
                className="text-center text-2xl font-mono tracking-widest"
                autoFocus
              />
            </div>

            {/* Trust Device Checkbox */}
            <div className="flex items-center space-x-2">
              <Checkbox
                id="trustDevice"
                checked={trustThisDevice}
                onCheckedChange={(checked) => setTrustThisDevice(checked === true)}
                className="border-border"
              />
              <Label
                htmlFor="trustDevice"
                className="text-sm text-foreground cursor-pointer"
              >
                trust this device for 30 days
              </Label>
            </div>

            <Button
              type="submit"
              disabled={
                isSubmitting ||
                isPasskeyPending ||
                (!useBackupCode && verificationCode.length !== 6) ||
                (useBackupCode && !verificationCode)
              }
              className="w-full"
            >
              {isSubmitting ? 'verifying...' : 'verify'}
            </Button>

            <div className="space-y-2">
              <Button
                type="button"
                variant="link"
                onClick={() => {
                  setUseBackupCode(!useBackupCode);
                  setVerificationCode('');
                }}
                className="w-full text-sm"
              >
                {useBackupCode
                  ? 'use authenticator app instead'
                  : 'use backup code instead'}
              </Button>

              <Button
                type="button"
                variant="ghost"
                onClick={handleCancel}
                className="w-full text-sm"
              >
                cancel and sign out
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export default function Verify2FAPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <p>loading...</p>
      </div>
    }>
      <Verify2FAContent />
    </Suspense>
  );
}
