'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { generateBackupCodes } from '@/lib/totp';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from 'sonner';
import Image from 'next/image';

export default function Setup2FAPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  const [secret, setSecret] = useState('');
  const [qrCodeUrl, setQrCodeUrl] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [step, setStep] = useState<'setup' | 'verify' | 'backup'>('setup');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && !user) {
      router.push('/login');
      return;
    }

    if (user && step === 'setup' && !secret) {
      // Generate TOTP secret and QR code via API
      fetch('/api/mfa/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.uid,
          email: user.email,
        }),
      })
        .then((res) => res.json())
        .then((data) => {
          if (data.error) {
            throw new Error(data.error);
          }
          setSecret(data.secret);
          setQrCodeUrl(data.qrCodeUrl);
        })
        .catch((error) => {
          console.error('Failed to generate MFA setup:', error);
          toast.error('Failed to generate QR code');
        });
    }
  }, [user, loading, router, step, secret]);

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!verificationCode || verificationCode.length !== 6) {
      toast.error('Please enter a 6-digit code');
      return;
    }

    if (!user) {
      toast.error('User not authenticated');
      return;
    }

    setIsSubmitting(true);

    try {
      // Generate backup codes
      const codes = generateBackupCodes(10);

      // Verify TOTP code and save encrypted secret via API
      const response = await fetch('/api/mfa/verify-setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.uid,
          code: verificationCode,
          backupCodes: codes,
        }),
      });

      const data = await response.json();

      if (!response.ok || data.error) {
        toast.error(data.error || 'Invalid code', {
          description: 'Please check your authenticator app and try again.',
        });
        setIsSubmitting(false);
        return;
      }

      // Store backup codes for display
      setBackupCodes(codes);

      toast.success('2FA Enabled', {
        description: 'Two-factor authentication has been enabled successfully.',
      });

      // Move to backup codes step
      setStep('backup');
    } catch (error) {
      console.error('Error enabling 2FA:', error);
      toast.error('Failed to enable 2FA');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFinish = () => {
    toast.success('Setup Complete', {
      description: 'You can now access your dashboard.',
    });
    router.push('/dashboard');
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
  };

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
        <CardHeader>
          <CardTitle>Set Up Two-Factor Authentication</CardTitle>
          <CardDescription>
            Secure your account with two-factor authentication (2FA)
          </CardDescription>
        </CardHeader>
        <CardContent>
          {step === 'setup' && (
            <div className="space-y-6">
              <div className="text-sm text-muted-foreground space-y-2">
                <p className="font-semibold text-foreground">Step 1: Scan QR Code</p>
                <p>Open your authenticator app (Google Authenticator, Authy, etc.) and scan this QR code:</p>
              </div>

              {qrCodeUrl && (
                <div className="flex justify-center">
                  <Image
                    src={qrCodeUrl}
                    alt="2FA QR Code"
                    width={250}
                    height={250}
                    className="border rounded-lg"
                  />
                </div>
              )}

              <div className="space-y-2">
                <p className="text-sm font-semibold text-muted-foreground">Manual Entry Code:</p>
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
                    Copy
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  If you cannot scan the QR code, enter this code manually in your authenticator app.
                </p>
              </div>

              <div className="space-y-2">
                <Button
                  onClick={() => setStep('verify')}
                  className="w-full bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
                >
                  Continue to Verification
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => router.back()}
                  className="w-full text-sm text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {step === 'verify' && (
            <form onSubmit={handleVerify} className="space-y-6">
              <div className="text-sm text-muted-foreground space-y-2">
                <p className="font-semibold text-foreground">Step 2: Verify Setup</p>
                <p>Enter the 6-digit code from your authenticator app to verify:</p>
              </div>

              <div className="space-y-2">
                <Input
                  type="text"
                  placeholder="000000"
                  value={verificationCode}
                  onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  maxLength={6}
                  className="text-center text-2xl font-mono tracking-widest h-16 px-4"
                  autoFocus
                />
              </div>

              <div className="space-y-2">
                <Button
                  type="submit"
                  disabled={isSubmitting || verificationCode.length !== 6}
                  className="w-full bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
                >
                  {isSubmitting ? 'Verifying...' : 'Verify & Enable 2FA'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setStep('setup')}
                  disabled={isSubmitting}
                  className="w-full"
                >
                  Back
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => router.back()}
                  disabled={isSubmitting}
                  className="w-full text-sm text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}

          {step === 'backup' && (
            <div className="space-y-6">
              <div className="text-sm text-muted-foreground space-y-2">
                <p className="font-semibold text-red-400">Step 3: Save Backup Codes</p>
                <p>
                  Save these backup codes in a secure location. You can use them to access your account
                  if you lose access to your authenticator app.
                </p>
                <p className="text-red-400 font-semibold">
                  These codes will only be shown once!
                </p>
              </div>

              <div className="bg-card border border-border rounded-lg p-4">
                <div className="grid grid-cols-2 gap-2 font-mono text-sm">
                  {backupCodes.map((code, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <span className="text-muted-foreground">{index + 1}.</span>
                      <span className="font-bold text-foreground">{code}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <Button
                  onClick={handleFinish}
                  className="w-full bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
                >
                  I've Saved My Codes
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => copyToClipboard(backupCodes.join('\n'))}
                  className="w-full"
                >
                  Copy All Codes
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
