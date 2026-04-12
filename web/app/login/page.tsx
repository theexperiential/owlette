'use client';

import { Suspense, useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Fingerprint } from 'lucide-react';
import { toast } from 'sonner';
import { sanitizeError } from '@/lib/errorHandler';
import { doc, getDoc } from 'firebase/firestore';
import { signInWithCustomToken } from 'firebase/auth';
import { OwletteEyeIcon } from '@/components/landing/OwletteEye';
import { auth as firebaseAuth, db } from '@/lib/firebase';
import { isDeviceTrusted, setMfaVerifiedForSession } from '@/lib/mfaSession';
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';

function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [redirectUrl, setRedirectUrl] = useState('/dashboard');
  const { signIn, signInWithGoogle } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  // Read redirect parameter from URL (validated: must be a safe relative path)
  useEffect(() => {
    const redirect = searchParams.get('redirect');
    if (redirect && redirect.startsWith('/') && !redirect.startsWith('//')) {
      setRedirectUrl(redirect);
    }
  }, [searchParams]);

  // Helper function to check MFA status and determine redirect
  const checkMfaAndRedirect = async (): Promise<string> => {
    try {
      if (!firebaseAuth?.currentUser || !db) {
        return redirectUrl;
      }

      const userId = firebaseAuth.currentUser.uid;

      // Check if device is trusted (skip MFA for 30 days)
      if (isDeviceTrusted(userId)) {
        setMfaVerifiedForSession(userId);
        return redirectUrl;
      }

      // Get user document to check MFA enrollment
      const userDocRef = doc(db, 'users', userId);
      const userDocSnap = await getDoc(userDocRef);

      if (userDocSnap.exists()) {
        const userData = userDocSnap.data();

        // If MFA is enrolled, redirect to verification
        if (userData.mfaEnrolled) {
          return `/verify-2fa?return=${encodeURIComponent(redirectUrl)}`;
        }
      }

      // No MFA needed, mark session as verified and proceed
      setMfaVerifiedForSession(userId);
      return redirectUrl;
    } catch (error) {
      console.error('Error checking MFA status:', error);
      return redirectUrl; // Fallback to normal redirect
    }
  };

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      await signIn(email, password);

      // Wait a moment for Firebase Auth state to update
      await new Promise(resolve => setTimeout(resolve, 500));

      // Check MFA status and get redirect path
      const redirectPath = await checkMfaAndRedirect();

      if (redirectPath.includes('/verify-2fa')) {
        toast.info('2FA verification required');
      } else {
        toast.success('logged in successfully!');
      }

      router.push(redirectPath);
    } catch (error) {
      toast.error(sanitizeError(error));
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setLoading(true);

    try {
      await signInWithGoogle();

      // Wait a moment for Firebase Auth state to update
      await new Promise(resolve => setTimeout(resolve, 500));

      // Check MFA status and get redirect path
      const redirectPath = await checkMfaAndRedirect();

      if (redirectPath.includes('/verify-2fa')) {
        toast.info('2FA verification required');
      } else {
        toast.success('logged in with Google!');
      }

      router.push(redirectPath);
    } catch (error) {
      toast.error(sanitizeError(error));
    } finally {
      setLoading(false);
    }
  };

  const handlePasskeyLogin = async () => {
    setLoading(true);

    try {
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

      // Step 2: Start WebAuthn authentication (browser prompt)
      const credential = await startAuthentication({ optionsJSON: options });

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

      const { customToken, userId } = await verifyRes.json();

      // Step 4: Sign in with Firebase custom token
      if (firebaseAuth) {
        await signInWithCustomToken(firebaseAuth, customToken);
      }

      // Step 5: Mark MFA as verified (passkey IS the second factor)
      setMfaVerifiedForSession(userId);

      toast.success('signed in with passkey!');
      router.push(redirectUrl);
    } catch (error) {
      if (error instanceof Error && error.name === 'NotAllowedError') {
        toast.error('passkey authentication was cancelled');
      } else {
        toast.error(sanitizeError(error));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md bg-card/50 border-border">
        <CardHeader className="space-y-4 flex flex-col items-center">
          <OwletteEyeIcon size={80} />
          <div className="space-y-1 text-center">
            <CardTitle className="text-2xl font-bold text-foreground">owlette</CardTitle>
            <CardDescription className="text-muted-foreground">
              attention is all you need
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={handleEmailLogin} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-foreground">email</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={loading}
                className="bg-input border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password" className="text-foreground">password</Label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={loading}
                className="bg-input border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <Button type="submit" className="w-full bg-accent-cyan hover:bg-accent-cyan-hover text-background font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed" disabled={loading}>
              {loading ? 'signing in...' : 'sign in with email'}
            </Button>
          </form>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card/50 px-2 text-muted-foreground">
                or continue with
              </span>
            </div>
          </div>

          <Button
            type="button"
            variant="outline"
            className="w-full bg-input border-border text-foreground hover:bg-muted hover:text-foreground cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
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
            Google
          </Button>

          {browserSupportsWebAuthn() && (
            <Button
              type="button"
              variant="outline"
              className="w-full bg-input border-border text-foreground hover:bg-muted hover:text-foreground cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handlePasskeyLogin}
              disabled={loading}
            >
              <Fingerprint className="mr-2 h-4 w-4" />
              passkey
            </Button>
          )}

          <div className="text-center text-sm text-muted-foreground">
            don't have an account?{' '}
            <a href="/register" className="text-accent-cyan hover:text-accent-cyan-hover hover:underline">
              sign up
            </a>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md bg-card/50 border-border">
          <CardHeader className="space-y-4 flex flex-col items-center">
            <OwletteEyeIcon size={80} />
            <div className="space-y-1 text-center">
              <CardTitle className="text-2xl font-bold text-foreground">owlette</CardTitle>
              <CardDescription className="text-muted-foreground">
                attention is all you need
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-center text-muted-foreground">loading...</div>
          </CardContent>
        </Card>
      </div>
    }>
      <LoginForm />
    </Suspense>
  );
}
