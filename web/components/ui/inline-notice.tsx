import { CircleAlertIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Neutral inline notice — the non-destructive sibling of `ui/form-error`: same
 * doctrine (sits beside the thing to act on, persists until resolved), different
 * tone. FormError is --destructive and means "this input is wrong"; this means
 * "here is what happened and what to do next" — a returning user who landed on
 * /register has not made an error.
 *
 * Takes children, not a message string, so the sentence can contain a link.
 */
export function InlineNotice({
  children,
  className,
  'data-testid': testId,
}: {
  children: React.ReactNode;
  className?: string;
  'data-testid'?: string;
}) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className={cn(
        'flex items-start gap-2 rounded-md border border-border bg-secondary/60 p-3',
        className,
      )}
    >
      <CircleAlertIcon
        className="mt-0.5 size-4 shrink-0 text-accent-cyan"
        aria-hidden="true"
      />
      <div className="min-w-0 space-y-3">{children}</div>
    </div>
  );
}
