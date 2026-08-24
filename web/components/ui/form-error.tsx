import { AlertCircleIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Inline form validation error — THE validation surface for owlette forms.
 * Replaces three prior patterns: the unstyleable native `required` bubble,
 * transient toasts, and a one-off /reset-password block hardcoding red-900/800/
 * 400. Rebuilt on --destructive.
 *
 * Inline rather than toast on purpose: a field error belongs beside the field
 * and must persist until fixed. Toasts stay for action outcomes.
 *
 * Forms using this must set `noValidate` (so the native bubble can't pre-empt
 * it) and own their empty-field checks; `required` stays for assistive tech.
 * Renders nothing when `message` is falsy. role="alert" announces on appear —
 * pair with aria-describedby where one error maps to one input.
 */
export function FormError({
  message,
  className,
  id,
}: {
  message?: string | null;
  className?: string;
  id?: string;
}) {
  if (!message) return null;

  return (
    <div
      id={id}
      role="alert"
      className={cn(
        'flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3',
        className,
      )}
    >
      <AlertCircleIcon
        className="mt-0.5 size-4 shrink-0 text-destructive"
        aria-hidden="true"
      />
      <p className="text-sm leading-snug text-destructive">{message}</p>
    </div>
  );
}
