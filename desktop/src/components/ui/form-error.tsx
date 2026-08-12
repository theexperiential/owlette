import { AlertCircleIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Inline form validation error.
 *
 * THE validation surface for owlette forms. Three patterns were in play before
 * this existed: the browser's native `required` bubble (unstyleable, and
 * visually foreign to the app), transient toasts, and a one-off inline block on
 * /reset-password that hardcoded red-900/red-800/red-400. This consolidates
 * them on the last one, rebuilt on --destructive.
 *
 * Inline rather than toast on purpose: a field error belongs next to the field
 * and should persist until fixed, not expire in a corner of the screen. Toasts
 * remain the right surface for the outcome of an action (saved, failed,
 * dispatched) — not for "this input is wrong".
 *
 * Forms using this must set `noValidate` so the native bubble never pre-empts
 * it, and own their own empty-field checks — `required` still marks intent for
 * assistive tech and is left in place.
 *
 * Renders nothing when `message` is falsy, so callers can pass state directly.
 * role="alert" announces the message when it appears; pair with
 * aria-describedby on the field where one error maps to one input.
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
