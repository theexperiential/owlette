'use client';

import { useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface BackupCodesPanelProps {
  /** The plaintext sheet, in issue order. Shown once and never re-readable. */
  codes: string[];
  /** Heading above the sheet. Defaults to "save backup codes". */
  title?: string;
  /** Extra classes for the outer wrapper. */
  className?: string;
  /** How long (ms) the copy button's check icon sticks. Defaults to 2000. */
  successDuration?: number;
}

/**
 * The shown-once backup-codes display. Purely presentational — takes the
 * plaintext sheet as a prop, fetches nothing — which is what lets one component
 * serve both issuance paths (`/setup-2fa` enrollment and account settings).
 *
 * The "only shown once" warning is load-bearing: the server stores hashes only,
 * so navigating away without saving means regenerating, which needs a factor
 * the user may no longer hold.
 */
export function BackupCodesPanel({
  codes,
  title = 'save backup codes',
  className,
  successDuration = 2000,
}: BackupCodesPanelProps) {
  const [copied, setCopied] = useState(false);
  // Track the latest timer: a second click before the first reset must not
  // leave the button stuck on "copied" when the new write fails.
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function handleCopyAll() {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
      toast.success('copied to clipboard');
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), successDuration);
    } catch (err) {
      // Denied permission, insecure context, or no clipboard API — say so
      // rather than imply the codes were saved.
      console.error('clipboard write failed:', err);
      toast.error('copy failed — select the codes and copy with Ctrl+C');
    }
  }

  return (
    <div className={cn('space-y-6', className)}>
      <div className="text-sm text-muted-foreground space-y-2">
        <p className="font-semibold text-destructive">{title}</p>
        <p>
          save these backup codes in a secure location. you can use them to access your account
          if you lose access to your authenticator app or passkey.
        </p>
        <p className="text-destructive font-semibold">these codes will only be shown once!</p>
      </div>

      <div className="bg-card border border-border rounded-lg p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 font-mono text-sm">
          {codes.map((code, index) => (
            <div key={`${index}-${code}`} className="flex items-center gap-2">
              <span className="text-muted-foreground">{index + 1}.</span>
              <span className="font-bold text-foreground">{code}</span>
            </div>
          ))}
        </div>
      </div>

      <Button
        type="button"
        variant="outline"
        onClick={handleCopyAll}
        aria-label={copied ? 'copied' : 'copy all codes'}
        className="w-full"
      >
        {copied ? <Check className="h-4 w-4 text-accent-cyan" /> : <Copy className="h-4 w-4" />}
        {copied ? 'copied' : 'copy all codes'}
      </Button>
    </div>
  );
}
