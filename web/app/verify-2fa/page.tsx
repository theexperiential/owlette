'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { trustDevice } from '@/lib/mfaSession';

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

      // Trust device for 30 days if checked. This is currently a
      // client-side hint only — the proxy still gates protected paths
      // on the server-side session, which always requires MFA when
      // enrolled. Wave 3 will wire trusted-device support into the
      // session cookie so this checkbox behaves as labelled.
      if (trustThisDevice) {
        trustDevice(user.uid);
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

  const handleCancel = async () => {
    await signOut();
    router.push('/login');
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-900 to-gray-800 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Two-Factor Authentication</CardTitle>
          <CardDescription>
            {useBackupCode
              ? 'Enter one of your backup codes'
              : 'Enter the code from your authenticator app'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleVerify} className="space-y-6">
            <div className="space-y-2">
              <Input
                type="text"
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
                Trust this device for 30 days
              </Label>
            </div>

            <Button
              type="submit"
              disabled={
                isSubmitting ||
                (!useBackupCode && verificationCode.length !== 6) ||
                (useBackupCode && !verificationCode)
              }
              className="w-full"
            >
              {isSubmitting ? 'Verifying...' : 'Verify'}
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
                  ? 'Use authenticator app instead'
                  : 'Use backup code instead'}
              </Button>

              <Button
                type="button"
                variant="ghost"
                onClick={handleCancel}
                className="w-full text-sm"
              >
                Cancel and sign out
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
        <p>Loading...</p>
      </div>
    }>
      <Verify2FAContent />
    </Suspense>
  );
}
