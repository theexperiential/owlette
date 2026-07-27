'use client';

import { useCallback, useState } from 'react';

/**
 * Field-targeted form validation state.
 *
 * A message alone ("enter your email address") tells the user WHAT is wrong but
 * not WHERE — on a form with six inputs that is a scavenger hunt. This pairs
 * the message with the offending field id so the input can be marked invalid
 * (red outline via the Input primitive's aria-invalid styling) and focused, and
 * the message rendered near the submit for the summary.
 *
 * Usage:
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
    // Move the caret to the problem. Deferred a tick so it runs after the
    // re-render that applies aria-invalid, otherwise focus can land before the
    // field is marked and some browsers skip the announcement.
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        const el = document.getElementById(field);
        if (el instanceof HTMLElement) el.focus();
      }, 0);
    }
    return undefined;
  }, []);

  /**
   * Spread onto the Input. Marks only the offending field invalid, and points
   * assistive tech at the message so it is announced with the field rather
   * than read as a floating alert.
   */
  const fieldProps = useCallback(
    (field: string) =>
      error?.field === field
        ? ({ 'aria-invalid': true, 'aria-describedby': errorElementId } as const)
        : ({} as const),
    [error, errorElementId],
  );

  return { error, fail, clear, fieldProps };
}
