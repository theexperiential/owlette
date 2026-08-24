import { CircleAlertIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Neutral inline notice — the non-destructive sibling of `ui/form-error`. Same doctrine (persist
 * next to the thing the user must act on), different tone: FormError is --destructive and says
 * "this input is wrong"; this says what happened and what to do next. A returning user who landed
 * on /register has not made an error.
 *
 * Takes children, not a message string, so callers can put a link in the sentence.
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
