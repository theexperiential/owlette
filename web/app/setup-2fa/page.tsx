'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import { Fingerprint, Smartphone } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useInAppBrowser } from '@/hooks/useInAppBrowser';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { BackupCodesPanel } from '@/components/BackupCodesPanel';
import { OwletteEyeIcon } from '@/components/landing/OwletteEye';
import { toast } from '@/lib/toast';
/* eslint-disable @next/next/no-img-element */

/**
 * The enrollment wizard.
 *
 *   choose ─┬─ totp-setup ─ totp-verify ─┬─ backup
 *           └─ passkey-register ─────────┘
 *
 * `choose` exists because this page used to BE the TOTP flow: a QR code and
 * nothing else, whose only other control was "sign out". A beta tester with no
 * phone to hand could not finish signing up in a browser at all. Both branches
 * terminate at the same `backup` step, so recovery material is issued whichever
 * factor the account enrolled.
 */
type SetupStep = 'choose' | 'totp-setup' | 'totp-verify' | 'passkey-register' | 'backup';

/** A refusal body from the enrollment routes — `{ error, code }` repo-wide. */
interface EnrollmentErrorBody {
  error?: string;
  code?: string;
}

export default function Setup2FAPage() {
  const { user, loading, requiresMfaSetup, signOut } = useAuth();
  const router = useRouter();
  const inApp = useInAppBrowser();

  const [secret, setSecret] = useState('');
  const [qrCodeUrl, setQrCodeUrl] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [step, setStep] = useState<SetupStep>('choose');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  /** True while either of the passkey branch's two WebAuthn ceremonies runs. */
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  /**
   * The credential exists on the account. From here the factor is enrolled and
   * the session is already MFA-satisfied (register/verify promotes the session
   * for the FIRST factor), so everything left on that step is about recovery
   * codes — never about whether setup succeeded.
   */
  const [passkeyCreated, setPasskeyCreated] = useState(false);
  /**
   * WebAuthn support can only be detected client-side (`browserSupportsWebAuthn`
   * reads `window.PublicKeyCredential`), so it starts 'unknown' and matches the
   * server render — the same hydration guard /login documents at length. The
   * third state is what lets us tell "not checked yet" (say nothing) apart from
   * "checked, unsupported" (explain why the option is missing).
   */
  const [passkeySupport, setPasskeySupport] = useState<'unknown' | 'yes' | 'no'>('unknown');

  /**
   * Passkeys are hidden inside an embedded webview even though the API is
   * present: the ceremony can only use credentials for the HOST app's
   * associated domain, which will never be owlette.app. Offering a button that
   * is guaranteed to fail is worse than not offering it — and unlike /login,
   * setup here is mandatory, so the TOTP branch has to carry the whole flow
   * when this is false.
   */
  const showPasskey = passkeySupport === 'yes' && !inApp.isInApp;

  useEffect(() => {
    setPasskeySupport(browserSupportsWebAuthn() ? 'yes' : 'no');
  }, []);

  /**
   * Surface a refusal from an enrollment route in words the user can act on.
   *
   * The one code worth branching on is the Wave-2 enrollment gate. This page is
   * normally the zero-factor path, where that gate is open by design — but a
   * session that already holds a factor (a second enrollment started from
   * account settings, or a cookie whose cached state has drifted) gets a 403
   * here, and `mfa_challenge_required` on its own is a slug, not an
   * instruction. Clearing the challenge is the fix, so send them where that
   * happens instead of printing the slug.
   */
  const reportEnrollmentFailure = useCallback(
    (status: number, data: EnrollmentErrorBody, fallback: string) => {
      if (status === 403 && data.code === 'mfa_challenge_required') {
        toast.error('verify your existing 2FA first', {
          description:
            'this account already has a factor, so this session has to clear a challenge before adding another. taking you there now.',
        });
        router.push('/verify-2fa');
        return;
      }
      toast.error(data.error || fallback);
    },
    [router],
  );

  useEffect(() => {
    if (!loading && !user) {
      // replace, not push: pushing leaves /setup-2fa one back-press away, and
      // going back to a page that immediately redirects again is a trap. It
      // also collapses the double history entry when handleCancel signs someone
      // out and lands them here itself.
      router.replace('/login');
      return;
    }

    // Only once the TOTP branch is actually chosen. Minting a secret up front
    // would provision a half-finished authenticator entry on the account of
    // every user who goes on to enroll a passkey instead.
    if (user && step === 'totp-setup' && !secret) {
      // Generate TOTP secret and QR code via API
      (async () => {
        try {
          const res = await fetch('/api/mfa/setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              userId: user.uid,
              email: user.email,
            }),
          });
          const data = await res.json();
          if (!res.ok || data.error) {
            reportEnrollmentFailure(res.status, data, `server error (${res.status})`);
            return;
          }
          setSecret(data.secret);
          setQrCodeUrl(data.qrCodeUrl);
        } catch (error) {
          console.error('Failed to generate MFA setup:', error);
          toast.error('failed to generate QR code', {
            description: error instanceof Error ? error.message : undefined,
          });
        }
      })();
    }
  }, [user, loading, router, step, secret, reportEnrollmentFailure]);

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!verificationCode || verificationCode.length !== 6) {
      toast.error('enter the 6-digit code');
      return;
    }

    if (!user) {
      toast.error('you are not signed in');
      return;
    }

    setIsSubmitting(true);

    try {
      // The sheet is NOT generated in the browser any more. `verify-setup`
      // mints it in-process and returns the plaintext exactly once — the same
      // seam that lets the passkey branch below get codes at all, and it keeps
      // the hashing, the count and the ordering on one side of the wire.
      const response = await fetch('/api/mfa/verify-setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.uid,
          code: verificationCode,
        }),
      });

      const data = await response.json();

      if (!response.ok || data.error) {
        if (response.status === 403 && data.code === 'mfa_challenge_required') {
          reportEnrollmentFailure(response.status, data, 'could not enable 2FA');
          return;
        }
        toast.error(data.error || 'invalid code', {
          description: 'check your authenticator app and try again.',
        });
        return;
      }

      toast.success('2FA enabled', {
        description: 'two-factor authentication is on for this account.',
      });

      const issued: string[] = Array.isArray(data.backupCodes)
        ? data.backupCodes.filter((code: unknown): code is string => typeof code === 'string')
        : [];

      if (issued.length === 0) {
        // Shouldn't happen — the route always returns a sheet. If it ever does,
        // an empty "save these codes" panel is a worse lie than saying nothing
        // came back: the factor is enrolled either way, so let them through and
        // point at the surface that can mint a replacement.
        toast.error('your backup codes did not come through', {
          description: 'generate a new set from account settings.',
        });
        router.push('/dashboard');
        return;
      }

      setBackupCodes(issued);
      setStep('backup');
    } catch (error) {
      console.error('Error enabling 2FA:', error);
      toast.error('failed to enable 2FA');
    } finally {
      setIsSubmitting(false);
    }
  };

  /**
   * The passkey branch runs the WebAuthn ceremonies inline rather than mounting
   * `PasskeyManager` or calling `usePasskeys().registerPasskey`. That component
   * is a list-management surface — add/rename/delete for an account that
   * already holds credentials — and its hook refetches `/api/passkeys/list`
   * after every write; neither is what a one-shot wizard step needs, and this
   * page should not be coupled to that component's layout. The requests below
   * are the same three-step ceremony `usePasskeys` and /login run, so the
   * shapes stay in step with them.
   *
   * No name prompt: during MANDATORY setup an extra text field between the user
   * and a working account is pure friction. The server defaults the credential
   * to "Passkey" and account settings can rename it afterwards.
   */
  const handleCreatePasskey = async () => {
    if (!user) {
      toast.error('you are not signed in');
      return;
    }

    setPasskeyBusy(true);
    try {
      const optionsRes = await fetch('/api/passkeys/register/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.uid }),
      });
      const options = await optionsRes.json();
      if (!optionsRes.ok || options.error) {
        reportEnrollmentFailure(optionsRes.status, options, 'could not start passkey setup');
        return;
      }

      const credential = await startRegistration({ optionsJSON: options });

      const verifyRes = await fetch('/api/passkeys/register/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.uid, credential }),
      });
      const verifyData = await verifyRes.json();
      if (!verifyRes.ok || verifyData.error) {
        reportEnrollmentFailure(verifyRes.status, verifyData, 'could not finish passkey setup');
        return;
      }

      setPasskeyCreated(true);
      toast.success('passkey created', {
        description: 'you can sign in with it from now on.',
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'NotAllowedError') {
        toast.error('passkey setup was cancelled');
      } else {
        console.error('Error registering passkey:', error);
        toast.error(error instanceof Error ? error.message : 'failed to create passkey');
      }
    } finally {
      setPasskeyBusy(false);
    }
  };

  /**
   * Backup codes for the passkey branch.
   *
   * `/api/mfa/backup-codes` demands live proof of possession IN the request — a
   * warm session is explicitly not enough there, and the route carries no
   * bypass to reach for. What a user who has just registered their first
   * passkey can present is that passkey: a step-up assertion is one of the
   * three proofs the route accepts, precisely so a passkey-only account can
   * mint its first sheet. So the second system prompt is deliberate, not a
   * glitch — hence a button that names it before it appears, which also keeps
   * `navigator.credentials.get` inside a user gesture (Safari requires one).
   */
  const handleClaimBackupCodes = async () => {
    setPasskeyBusy(true);
    try {
      const optionsRes = await fetch('/api/passkeys/step-up/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const optionsData = await optionsRes.json();
      if (!optionsRes.ok || optionsData.error) {
        toast.error(optionsData.error || 'could not start passkey verification');
        return;
      }

      const credential = await startAuthentication({ optionsJSON: optionsData.options });

      const codesRes = await fetch('/api/mfa/backup-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential, challengeId: optionsData.challengeId }),
      });
      const codesData = await codesRes.json();
      if (!codesRes.ok || codesData.error) {
        toast.error(codesData.error || 'could not create backup codes');
        return;
      }

      const issued: string[] = Array.isArray(codesData.backupCodes)
        ? codesData.backupCodes.filter((code: unknown): code is string => typeof code === 'string')
        : [];
      if (issued.length === 0) {
        toast.error('your backup codes did not come through', {
          description: 'try again, or generate a set from account settings.',
        });
        return;
      }

      setBackupCodes(issued);
      setStep('backup');
    } catch (error) {
      if (error instanceof Error && error.name === 'NotAllowedError') {
        toast.error('passkey verification was cancelled');
      } else {
        console.error('Error creating backup codes:', error);
        toast.error(error instanceof Error ? error.message : 'failed to create backup codes');
      }
    } finally {
      setPasskeyBusy(false);
    }
  };

  const handleFinish = () => {
    toast.success('setup complete', {
      description: 'you can now access your dashboard.',
    });
    router.push('/dashboard');
  };

  /**
   * Bailing out of 2FA setup. This used to be `router.back()`, which for a
   * brand-new signup means /register — the form they had just submitted. An
   * authenticated user staring at a blank signup form concludes the signup
   * never took, fills it in again, and gets auth/email-already-in-use with
   * nowhere to go: that is OWLETTE-WEB-46, reported by a real user.
   *
   * History is not a destination. Where "cancel" leads depends on why they are
   * on this page at all:
   *
   *   - Mandatory. `requiresMfaSetup` is set at bootstrap for every new signup
   *     (lib/actions/bootstrapUser.server.ts), and dashboard/page.tsx pushes
   *     straight back here while it holds — so /dashboard is a loop, not an
   *     exit. Ending the session is the only honest way out, and it leaves
   *     nothing half-onboarded behind: they sign back in and get nagged again.
   *   - Voluntary — enrolling a second factor from account settings. The
   *     dashboard is where they came from and will not bounce them back.
   */
  const handleCancel = async () => {
    if (!requiresMfaSetup) {
      router.replace('/dashboard');
      return;
    }

    setIsCancelling(true);
    try {
      await signOut();
    } catch {
      // signOut raises its own toast. Stay put rather than sending a user who
      // is demonstrably still signed in to /login.
      setIsCancelling(false);
      return;
    }
    router.replace('/login');
  };

  /**
   * Say what the button does. When 2FA is mandatory there is nothing to cancel
   * back to — the action is ending the session, and calling that "cancel"
   * is how you get a user who did not expect to be signed out.
   */
  const cancelLabel = requiresMfaSetup ? 'sign out' : 'cancel';

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('copied to clipboard');
  };

  /**
   * The bail-out control, identical on every step before the codes are issued —
   * one definition so the OWLETTE-WEB-46 destination and the `cancelLabel`
   * cannot drift apart between branches as steps are added.
   */
  const cancelButton = (
    <Button
      type="button"
      variant="ghost"
      onClick={handleCancel}
      disabled={isCancelling || isSubmitting || passkeyBusy}
      className="w-full text-sm text-muted-foreground hover:text-foreground"
    >
      {cancelLabel}
    </Button>
  );

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative">
      {/* Grid background */}
      <div className="absolute inset-0 dot-grid opacity-30" />
      <div className="absolute inset-0 blueprint-grid opacity-15" />
      <Card className="relative z-10 w-full max-w-2xl border-border bg-card">
        <CardHeader className="space-y-4 flex flex-col items-center">
          <OwletteEyeIcon size={80} />
          <div className="space-y-1 text-center">
            <CardTitle className="text-2xl font-bold text-foreground">set up two-factor authentication</CardTitle>
            <CardDescription className="text-muted-foreground">
              secure your account with two-factor authentication (2FA)
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {step === 'choose' && (
            <div className="space-y-6">
              <div className="text-sm text-muted-foreground space-y-2">
                <p className="font-semibold text-foreground">choose your second factor</p>
                <p>pick one to finish setting up. you can add the other later from account settings.</p>
              </div>

              {/* Passkey first, and labelled recommended: one ceremony, no
                  second device, and it replaces the password at sign-in too. */}
              <div className="space-y-3">
                {showPasskey && (
                  <button
                    type="button"
                    onClick={() => setStep('passkey-register')}
                    className="w-full cursor-pointer rounded-lg border border-border bg-card/50 p-4 text-left transition-colors hover:border-accent-cyan hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <div className="flex items-start gap-3">
                      <Fingerprint className="mt-0.5 h-5 w-5 shrink-0 text-accent-cyan" />
                      <div className="space-y-1">
                        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                          passkey
                          <span className="rounded-full border border-accent-cyan/40 px-2 py-0.5 text-xs font-medium text-accent-cyan">
                            recommended
                          </span>
                        </p>
                        <p className="text-sm text-muted-foreground">
                          use windows hello, touch ID, face ID, a security key, or a password manager.
                          nothing else to install.
                        </p>
                      </div>
                    </div>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setStep('totp-setup')}
                  className="w-full cursor-pointer rounded-lg border border-border bg-card/50 p-4 text-left transition-colors hover:border-accent-cyan hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex items-start gap-3">
                    <Smartphone className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                    <div className="space-y-1">
                      <p className="text-sm font-semibold text-foreground">authenticator app</p>
                      <p className="text-sm text-muted-foreground">
                        use a 6-digit code app on your phone or desktop — 1Password, Bitwarden, Authy,
                        Google Authenticator.
                      </p>
                    </div>
                  </div>
                </button>
              </div>

              {/* Only once the client has actually checked. Declaring "not
                  supported" during the pre-hydration render would be a guess,
                  and this is the sentence that stops a user hunting for an
                  option that was never going to appear. */}
              {passkeySupport !== 'unknown' && !showPasskey && (
                <p className="text-xs text-muted-foreground">
                  {inApp.isInApp
                    ? `passkeys cannot be created inside ${inApp.appName ?? 'this app'}'s in-app browser — open owlette in your browser if you want one.`
                    : 'this browser cannot create passkeys, so an authenticator app is the way in here.'}
                </p>
              )}

              {cancelButton}
            </div>
          )}

          {step === 'totp-setup' && (
            <div className="space-y-6">
              <div className="text-sm text-muted-foreground space-y-2">
                <p className="font-semibold text-foreground">scan the QR code</p>
                <p>open your authenticator app (1Password, Bitwarden, Authy, Google Authenticator) and scan this QR code:</p>
              </div>

              {qrCodeUrl && (
                <div className="flex justify-center">
                  <img
                    src={qrCodeUrl}
                    alt="2FA QR Code"
                    width={250}
                    height={250}
                    className="border rounded-lg"
                  />
                </div>
              )}

              <div className="space-y-2">
                <p className="text-sm font-semibold text-muted-foreground">manual entry code:</p>
                <div className="flex gap-2">
                  <Input
                    value={secret}
                    readOnly
                    className="font-mono text-sm"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => copyToClipboard(secret)}
                  >
                    copy
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  if you cannot scan the QR code, enter this code manually in your authenticator app —
                  desktop apps take it too, so you do not need a phone.
                </p>
              </div>

              <div className="space-y-2">
                <Button
                  onClick={() => setStep('totp-verify')}
                  className="w-full text-gray-900 cursor-pointer"
                >
                  continue to verification
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setStep('choose')}
                  className="w-full"
                >
                  back
                </Button>
                {cancelButton}
              </div>
            </div>
          )}

          {step === 'totp-verify' && (
            <form onSubmit={handleVerify} className="space-y-6">
              <div className="text-sm text-muted-foreground space-y-2">
                <p className="font-semibold text-foreground">verify your authenticator</p>
                <p>enter the 6-digit code from your authenticator app to verify:</p>
              </div>

              <div className="space-y-2">
                <Input
                  type="text"
                  placeholder="000000"
                  value={verificationCode}
                  onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  maxLength={6}
                  className="text-center text-2xl font-mono tracking-widest h-16 px-4"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  name="otp"
                  autoFocus
                />
              </div>

              <div className="space-y-2">
                <Button
                  type="submit"
                  disabled={isSubmitting || verificationCode.length !== 6}
                  className="w-full text-gray-900 cursor-pointer"
                >
                  {isSubmitting ? 'verifying...' : 'verify & enable 2FA'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setStep('totp-setup')}
                  disabled={isSubmitting}
                  className="w-full"
                >
                  back
                </Button>
                {cancelButton}
              </div>
            </form>
          )}

          {step === 'passkey-register' && (
            <div className="space-y-6">
              <div className="text-sm text-muted-foreground space-y-2">
                <p className="font-semibold text-foreground">
                  {passkeyCreated ? 'passkey added' : 'create your passkey'}
                </p>
                <p>
                  {passkeyCreated
                    ? 'one more check with the same passkey and we can hand you your backup codes — the codes that get you back in if you ever lose this device.'
                    : 'your device will ask for its usual unlock: fingerprint, face, PIN, or your security key. that unlock is what proves it is you, so there is no code to type.'}
                </p>
              </div>

              <div className="space-y-2">
                {passkeyCreated ? (
                  <>
                    <Button
                      type="button"
                      onClick={handleClaimBackupCodes}
                      disabled={passkeyBusy}
                      className="w-full text-gray-900 cursor-pointer"
                    >
                      {passkeyBusy ? 'waiting for your device...' : 'get backup codes'}
                    </Button>
                    {/* The factor is already enrolled, so nothing on this screen
                        may hold the dashboard hostage — a cancelled prompt must
                        not strand a fully set-up account here. */}
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleFinish}
                      disabled={passkeyBusy}
                      className="w-full"
                    >
                      skip for now
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      type="button"
                      onClick={handleCreatePasskey}
                      disabled={passkeyBusy}
                      className="w-full text-gray-900 cursor-pointer"
                    >
                      {passkeyBusy ? 'waiting for your device...' : 'create passkey'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setStep('choose')}
                      disabled={passkeyBusy}
                      className="w-full"
                    >
                      back
                    </Button>
                  </>
                )}
                {cancelButton}
              </div>
            </div>
          )}

          {step === 'backup' && (
            <div className="space-y-6">
              <BackupCodesPanel codes={backupCodes} />

              <Button
                onClick={handleFinish}
                className="w-full text-gray-900 cursor-pointer"
              >
                continue to dashboard
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
