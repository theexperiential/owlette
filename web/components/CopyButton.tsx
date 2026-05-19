'use client';

import { useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface CopyButtonProps {
  /** The value written to the clipboard when clicked. */
  value: string;
  /** Toast message shown on successful copy. Defaults to "copied to clipboard". */
  successMessage?: string;
  /** Tooltip label. Defaults to "copy". */
  tooltipLabel?: string;
  /** Extra classes for the underlying Button. */
  className?: string;
  /** Button size. Defaults to "sm". */
  size?: 'sm' | 'default' | 'lg' | 'icon';
  /** Button variant. Defaults to "outline". */
  variant?: 'outline' | 'default' | 'ghost' | 'secondary';
  /** How long (ms) the success state (check icon) sticks. Defaults to 2000. */
  successDuration?: number;
}

/**
 * Copy-to-clipboard button with in-place visual confirmation.
 *
 * Why this exists: a bare `navigator.clipboard.writeText(value); toast.success(...)`
 * fires-and-forgets and the toast was easy to miss — operators reported clicking
 * the copy icon and getting no confirmation at all. This component gives the
 * primary signal *at the cursor* (icon swap to a check for 2s), keeps the toast
 * as a secondary signal, and properly handles a rejected clipboard promise so
 * a permissions failure surfaces an error toast instead of silently lying.
 */
export function CopyButton({
  value,
  successMessage = 'copied to clipboard',
  tooltipLabel = 'copy',
  className,
  size = 'sm',
  variant = 'outline',
  successDuration = 2000,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  // Track the latest timer so a second click before the first reset doesn't
  // get clobbered into "stuck checked forever" if the new write fails.
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(successMessage);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), successDuration);
    } catch (err) {
      // Permissions denied / insecure context / clipboard API unavailable.
      // Tell the operator instead of pretending it worked.
      console.error('clipboard write failed:', err);
      toast.error('copy failed — select the text manually and copy with Ctrl+C');
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size={size}
          variant={variant}
          onClick={handleCopy}
          aria-label={copied ? 'copied' : tooltipLabel}
          className={cn('cursor-pointer', className)}
        >
          {copied ? (
            <Check className="h-4 w-4 text-accent-cyan" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{copied ? 'copied' : tooltipLabel}</p>
      </TooltipContent>
    </Tooltip>
  );
}
