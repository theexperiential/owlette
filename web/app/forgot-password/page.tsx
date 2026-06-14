'use client';

import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { OwletteEyeIcon } from '@/components/landing/OwletteEye';

export default function ForgotPasswordPage() {
  const { sendPasswordReset } = useAuth();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await sendPasswordReset(email);
      // Existence-agnostic by design: we show the same confirmation whether or
      // not an account exists for this address (Firebase email-enumeration
      // protection makes sendPasswordReset resolve either way).
      setSent(true);
    } catch {
      // sendPasswordReset surfaces its own error toast (invalid email,
      // rate-limit, misconfiguration). Stay on the form so the user can retry.
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center p-4">
      {/* Grid background */}
      <div className="absolute inset-0 dot-grid opacity-30" />
      <div className="absolute inset-0 blueprint-grid opacity-15" />
      <Card className="relative z-10 w-full max-w-md border-border bg-card">
        <CardHeader className="space-y-4 flex flex-col items-center">
          <OwletteEyeIcon size={80} />
          <div className="space-y-1 text-center">
            <CardTitle className="text-2xl font-bold text-foreground">reset password</CardTitle>
            <CardDescription className="text-muted-foreground">
              {sent ? 'check your email' : "enter your email and we'll send you a reset link"}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {sent ? (
            <>
              <p className="text-center text-sm text-muted-foreground">
                if an account exists for <span className="text-foreground">{email}</span>, a
                password reset link is on its way. it can take a minute to arrive — be sure to
                check your spam folder.
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => setSent(false)}
                className="w-full bg-input border-border text-foreground cursor-pointer"
              >
                use a different email
              </Button>
              <div className="text-center text-sm text-muted-foreground">
                <a href="/login" className="text-accent-cyan hover:text-accent-cyan-hover hover:underline">
                  back to sign in
                </a>
              </div>
            </>
          ) : (
            <>
              <form onSubmit={handleSubmit} className="space-y-4">
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
                <Button
                  type="submit"
                  className="w-full bg-accent-cyan hover:bg-accent-cyan-hover text-background font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={loading || !email}
                >
                  {loading ? 'sending...' : 'send reset link'}
                </Button>
              </form>

              <div className="text-center text-sm text-muted-foreground">
                remember your password?{' '}
                <a href="/login" className="text-accent-cyan hover:text-accent-cyan-hover hover:underline">
                  sign in
                </a>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
