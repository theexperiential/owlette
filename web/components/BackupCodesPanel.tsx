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
 * The shown-once backup-codes display.
 *
 * Purely presentational: it takes the plaintext sheet as a prop and neither
 * fetches nor generates anything. That is what lets one component serve both
 * issuance paths — the enrollment flow in `/setup-2fa`, which gets its codes
 * from `POST /api/mfa/verify-setup`, and account settings, which gets them from
 * `POST /api/mfa/backup-codes` after a live proof of possession.
 *
 * The "only shown once" warning is load-bearing, not decoration: the server
 * stores hashes, so a user who navigates away without saving these has no way
 * to recover them short of regenerating (which invalidates the sheet they just
 * lost, and requires a factor they may no longer hold).
 */
export function BackupCodesPanel({
  codes,
  title = 'save backup codes',
  className,
  successDuration = 2000,
}: BackupCodesPanelProps) {
  const [copied, setCopied] = useState(false);
  // Track the latest timer so a second click before the first reset doesn't
  // leave the button stuck on "copied" if the new write fails.
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function handleCopyAll() {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
      toast.success('copied to clipboard');
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), successDuration);
    } catch (err) {
      // Permissions denied / insecure context / clipboard API unavailable.
      // Say so rather than pretending the codes are safely saved.
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
