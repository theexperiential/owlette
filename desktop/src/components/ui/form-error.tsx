import { AlertCircleIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * THE inline validation surface for owlette forms, replacing the native
 * `required` bubble, transient toasts, and the hardcoded red block that used to
 * live on /reset-password. Inline on purpose: a field error belongs beside its
 * field and must persist until fixed. Toasts stay for action outcomes.
 *
 * Forms using this MUST set `noValidate` so the native bubble can't pre-empt it,
 * and own their empty-field checks (`required` stays for assistive tech).
 *
 * Renders nothing when `message` is falsy, so callers can pass state directly.
 * role="alert" announces it; pair with aria-describedby for one-error-one-input.
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
