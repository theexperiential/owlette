import { CircleAlertIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Neutral inline notice — the non-destructive sibling of `ui/form-error`.
 *
 * Same doctrine as FormError: a condition the user must act on belongs next to
 * the thing they must act on, and should persist until resolved rather than
 * expire in a corner of the screen. The difference is tone. FormError is built
 * on --destructive and says "this input is wrong"; this says "here is what
 * happened and what to do next" without painting the screen red — a returning
 * user who landed on /register has not made an error.
 *
 * Takes children rather than a message string so callers can put a link in the
 * sentence, which is usually the entire point of showing one.
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
