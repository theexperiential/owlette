'use client';

import { useCallback, useState } from 'react';

/**
 * Form validation state paired with the offending field id, so the input can be
 * marked invalid (aria-invalid styling) and focused rather than leaving the user
 * to hunt for which of six inputs the message means.
 *
 *   const { error, fail, clear, fieldProps } = useFieldError();
 *   if (!email.trim()) return fail('email', 'enter your email address');
 *   <Input id="email" {...fieldProps('email')} />
 *   <FormError message={error?.message} id="register-error" />
 *
 * `fail` returns undefined so a validator can `return fail(...)` in one line.
 */
export interface FieldError {
  /** DOM id of the offending input — must match the element's `id`. */
  field: string;
  message: string;
}

export function useFieldError(errorElementId?: string) {
  const [error, setError] = useState<FieldError | null>(null);

  const clear = useCallback(() => setError(null), []);

  const fail = useCallback((field: string, message: string): undefined => {
    setError({ field, message });
    // Deferred a tick so focus lands AFTER the re-render that applies
    // aria-invalid — some browsers skip the announcement otherwise.
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        const el = document.getElementById(field);
        if (el instanceof HTMLElement) el.focus();
      }, 0);
    }
    return undefined;
  }, []);

  /** Spread onto the Input: marks only the offending field invalid and points
   *  assistive tech at the message so it is announced with the field. */
  const fieldProps = useCallback(
    (field: string) =>
      error?.field === field
        ? ({ 'aria-invalid': true, 'aria-describedby': errorElementId } as const)
        : ({} as const),
    [error, errorElementId],
  );

  return { error, fail, clear, fieldProps };
}
