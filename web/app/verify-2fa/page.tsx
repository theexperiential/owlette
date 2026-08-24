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
 * `browserSupportsWebAuthn()` reads `window.PublicKeyCredential`, so answering it during
 * render makes the passkey button server-absent / client-present. React recovers from that
 * hydration mismatch by discarding the SSR tree, which has swallowed clicks on these auth
 * pages before (see `canUsePasskey` in app/login/page.tsx).
 *
 * useSyncExternalStore rather than a mounted flag (matching `useInAppBrowser`): the server
 * snapshot is a real value, not an initial state to correct, so no cascading render. The
 * environment can't change within a document, so there is nothing to subscribe to.
 */
const subscribeWebAuthnSupport = () => () => {};
const getWebAuthnSupport = () => browserSupportsWebAuthn();
const getWebAuthnSupportOnServer = () => false;

function Verify2FAContent() {
  const { user, loading, signOut } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  // Accept `redirect` (proxy + login page) and the historical `return`. Must be a
  // same-origin relative path, else /dashboard — open-redirect guard.
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
  /** Also gated on the host app: in an embedded webview the ceremony can only use the HOST
   * app's passkeys, so browserSupportsWebAuthn() is true but the prompt always fails. Safe
   * to hide — TOTP and backup codes are always rendered. */
  const showPasskey = canUsePasskey && !inApp.isInApp;

  useEffect(() => {
    if (!loading && !user) {
      router.push('/login');
      return;
    }

    // The proxy already gates this page; the client re-check picks the right copy and
    // handles landing here with no active challenge (stale bookmark after disabling MFA).
    if (user && db) {
      const userDocRef = doc(db, 'users', user.uid);
      getDoc(userDocRef)
        .then((docSnap) => {
          if (docSnap.exists()) {
            const userData = docSnap.data();

            // Not enrolled: nothing to verify.
            if (!userData.mfaEnrolled) {
              router.push(returnUrl);
              return;
            }

            setMfaReady(true);
          } else {
            // No user document: nothing to verify.
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
      // Server-side verify — the TOTP secret never reaches the client.
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

      if (data.backupCodeUsed) {
        toast.success('Backup code used', {
          description: 'This backup code has been removed.',
        });
      }

      // /api/mfa/verify-login already flipped the session cookie to mfaVerified=true and,
      // when "trust this device" was checked, minted the HTTPOnly device-trust cookie. No
      // client-side flag; only claim trust when the server reports deviceTrusted.
      if (data.deviceTrusted) {
        toast.success('Verification Successful', {
          description: 'This device has been trusted for 30 days.',
        });
      } else {
        toast.success('Verification Successful', {
          description: 'Redirecting...',
        });
      }

      router.push(returnUrl);
    } catch (error) {
      console.error('Error verifying 2FA:', error);
      toast.error('Verification failed');
      setIsSubmitting(false);
    }
  };

  /**
   * Satisfy the gate with an owned passkey instead of a TOTP or backup code.
   *
   * Runs against `/api/passkeys/step-up/*`, NOT the `/authenticate/*` routes /login uses:
   * the caller is already signed in, so step-up requires a session, scopes the ceremony to
   * that session's uid, and only flips the MFA gate — no session or custom token is minted,
   * hence no `signInWithCustomToken` here.
   *
   * "trust this device" belongs to the code form; only /api/mfa/verify-login mints that cookie.
   */
  const handlePasskeyStepUp = async () => {
    if (!user) {
      toast.error('user not authenticated');
      return;
    }

    setIsPasskeyPending(true);

    try {
      // Options are scoped server-side to this session's own credentials.
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

      // Browser prompt (PIN/biometric — the server demands `uv`).
      const credential = await startAuthentication({ optionsJSON: optionsData.options });

      // On success the session cookie is already mfaVerified=true when this resolves.
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
      // Cancel/timeout is a user action, not a fault — don't surface the raw DOMException.
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
