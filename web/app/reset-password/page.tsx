'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { confirmPasswordReset, verifyPasswordResetCode } from 'firebase/auth';
import { auth } from '@/lib/firebase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { OwletteEyeIcon } from '@/components/landing/OwletteEye';
import { LoadingWord } from '@/components/LoadingWord';
import { EyeIcon, EyeOffIcon } from 'lucide-react';
import { toast } from 'sonner';

type Status = 'verifying' | 'ready' | 'invalid';

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const oobCode = searchParams.get('oobCode');

  const [status, setStatus] = useState<Status>('verifying');
  const [accountEmail, setAccountEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Validate the oobCode on mount. verifyPasswordResetCode resolves with the
  // account email when the code is valid, and rejects when it's malformed,
  // already used, or expired.
  useEffect(() => {
    if (!oobCode || !auth) {
      setStatus('invalid');
      return;
    }
    let cancelled = false;
    verifyPasswordResetCode(auth, oobCode)
      .then((email) => {
        if (cancelled) return;
        setAccountEmail(email);
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('invalid');
      });
    return () => {
      cancelled = true;
    };
  }, [oobCode]);

  const validate = (): boolean => {
    setError('');
    if (password.length < 6) {
      setError('password must be at least 6 characters');
      return false;
    }
    if (password !== confirm) {
      setError('passwords do not match');
      return false;
    }
    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!oobCode || !auth) {
      setStatus('invalid');
      return;
    }
    if (!validate()) return;

    setSubmitting(true);
    try {
      await confirmPasswordReset(auth, oobCode, password);
      toast.success('password updated', {
        description: 'you can now sign in with your new password.',
      });
      router.push('/login');
    } catch (err: unknown) {
      const code = (err as { code?: string } | null)?.code;
      if (code === 'auth/expired-action-code' || code === 'auth/invalid-action-code') {
        setStatus('invalid');
      } else if (code === 'auth/weak-password') {
        setError('password is too weak — please choose a stronger one');
      } else {
        setError('could not reset your password. please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md bg-card/50 border-border">
        <CardHeader className="space-y-4 flex flex-col items-center">
          <OwletteEyeIcon size={80} />
          <div className="space-y-1 text-center">
            <CardTitle className="text-2xl font-bold text-foreground">set a new password</CardTitle>
            <CardDescription className="text-muted-foreground">
              {status === 'ready'
                ? <>resetting the password for <span className="text-foreground">{accountEmail}</span></>
                : status === 'invalid'
                  ? 'this reset link is invalid or has expired'
                  : 'verifying your reset link…'}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {status === 'verifying' && (
            <div className="text-center text-muted-foreground"><LoadingWord /></div>
          )}

          {status === 'invalid' && (
            <div className="space-y-4">
              <p className="text-center text-sm text-muted-foreground">
                password reset links expire after a short while and can only be used once. request a fresh one to continue.
              </p>
              <Button
                type="button"
                onClick={() => router.push('/forgot-password')}
                className="w-full bg-accent-cyan hover:bg-accent-cyan-hover text-background font-medium cursor-pointer"
              >
                request a new link
              </Button>
              <div className="text-center text-sm text-muted-foreground">
                <a href="/login" className="text-accent-cyan hover:text-accent-cyan-hover hover:underline">
                  back to sign in
                </a>
              </div>
            </div>
          )}

          {status === 'ready' && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="newPassword" className="text-foreground">new password</Label>
                <div className="relative">
                  <Input
                    id="newPassword"
                    type={showPassword ? 'text' : 'password'}
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    disabled={submitting}
                    className="bg-input border-border pr-10 text-foreground placeholder:text-muted-foreground"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer text-muted-foreground hover:text-foreground"
                    aria-label={showPassword ? 'hide password' : 'show password'}
                  >
                    {showPassword ? <EyeOffIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">must be at least 6 characters</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirmPassword" className="text-foreground">confirm new password</Label>
                <Input
                  id="confirmPassword"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="••••••••"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  disabled={submitting}
                  className="bg-input border-border text-foreground placeholder:text-muted-foreground"
                />
              </div>

              {error && (
                <div className="rounded-md bg-red-900/20 border border-red-800 p-3">
                  <p className="text-sm text-red-400">{error}</p>
                </div>
              )}

              <Button
                type="submit"
                className="w-full bg-accent-cyan hover:bg-accent-cyan-hover text-background font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={submitting || !password || !confirm}
              >
                {submitting ? 'resetting...' : 'reset password'}
              </Button>

              <div className="text-center text-sm text-muted-foreground">
                <a href="/login" className="text-accent-cyan hover:text-accent-cyan-hover hover:underline">
                  back to sign in
                </a>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md bg-card/50 border-border">
          <CardHeader className="space-y-4 flex flex-col items-center">
            <OwletteEyeIcon size={80} />
            <div className="space-y-1 text-center">
              <CardTitle className="text-2xl font-bold text-foreground">set a new password</CardTitle>
              <CardDescription className="text-muted-foreground">verifying your reset link…</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-center text-muted-foreground"><LoadingWord /></div>
          </CardContent>
        </Card>
      </div>
    }>
      <ResetPasswordForm />
    </Suspense>
  );
}
