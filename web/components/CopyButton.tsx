'use client';

import { useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface CopyButtonProps {
  value: string;
  successMessage?: string;
  tooltipLabel?: string;
  className?: string;
  size?: 'sm' | 'default' | 'lg' | 'icon';
  variant?: 'outline' | 'default' | 'ghost' | 'secondary';
  /** ms the check icon sticks. */
  successDuration?: number;
}

/**
 * Copy-to-clipboard button. The icon swap is the primary confirmation — the
 * toast alone was routinely missed. Awaits the clipboard promise so a denied
 * permission surfaces an error instead of a false success.
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
  // Tracked so a rapid second click can't leave the check stuck on.
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(successMessage);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), successDuration);
    } catch (err) {
      // Denied permission / insecure context / no clipboard API.
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
