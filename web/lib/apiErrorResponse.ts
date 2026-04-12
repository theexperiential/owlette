/**
 * Centralized API route error response helper.
 *
 * Sanitizes error messages in production (hides Firebase internals, stack
 * traces, third-party API details) while preserving verbose output in
 * development for debugging.
 *
 * Usage in any API route catch block:
 *   import { apiError } from '@/lib/apiErrorResponse';
 *   ...
 *   } catch (error) {
 *     return apiError(error, 'admin/commands/send');
 *   }
 */
import { NextResponse } from 'next/server';
import { handleError } from './errorHandler';

/**
 * Build a sanitized NextResponse.json error response.
 *
 * @param error   - The caught error (any type)
 * @param context - Short label for log/Sentry context (e.g. 'agent/auth/refresh')
 * @param status  - HTTP status code (default 500)
 */
export function apiError(
  error: unknown,
  context?: string,
  status = 500,
): NextResponse {
  const message = handleError(error, context);
  return NextResponse.json({ error: message }, { status });
}
