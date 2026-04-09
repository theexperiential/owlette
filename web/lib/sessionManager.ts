/**
 * @deprecated This client-side session manager is deprecated and no longer used.
 *
 * SECURITY ISSUE: Client-side cookies are vulnerable to XSS attacks.
 * This file has been replaced with server-side session management.
 *
 * NEW IMPLEMENTATION:
 * - Server-side: lib/sessionManager.server.ts (HTTPOnly, encrypted cookies)
 * - API routes: app/api/auth/session/route.ts
 * - Used by: contexts/AuthContext.tsx, proxy.ts
 *
 * DO NOT USE THIS FILE IN NEW CODE.
 * Kept for backward compatibility during migration period only.
 *
 * Migration completed: 2025-11-17
 */

/**
 * Session Management Utility (DEPRECATED)
 * Handles setting and clearing session cookies for authentication
 */

/**
 * Sets a session cookie when user logs in
 * This cookie is checked by the proxy for route protection
 *
 * @param userId - The authenticated user's ID
 * @param expirationDays - Number of days until session expires (default: 7)
 */
export const setSessionCookie = (userId: string, expirationDays: number = 7): void => {
  // Only run in browser (not during SSR)
  if (typeof window === 'undefined') return;

  const expirationDate = new Date();
  expirationDate.setDate(expirationDate.getDate() + expirationDays);

  // Determine if we should use Secure flag (only on HTTPS)
  const isSecure = window.location.protocol === 'https:';
  const secureFlag = isSecure ? '; Secure' : '';

  // Set a simple session cookie
  // In production, this should be an encrypted token
  document.cookie = `__session=${userId}; expires=${expirationDate.toUTCString()}; path=/; SameSite=Lax${secureFlag}`;

  // Also set a shorter-lived auth indicator for the proxy
  document.cookie = `auth=true; expires=${expirationDate.toUTCString()}; path=/; SameSite=Lax${secureFlag}`;
};

/**
 * Clears the session cookie when user logs out
 */
export const clearSessionCookie = (): void => {
  // Only run in browser (not during SSR)
  if (typeof window === 'undefined') return;

  // Set expiration to past date to delete cookie
  document.cookie = '__session=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; SameSite=Lax';
  document.cookie = 'auth=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; SameSite=Lax';
};

/**
 * Checks if a valid session cookie exists (client-side check)
 * @returns True if session cookie exists
 */
export const hasSessionCookie = (): boolean => {
  if (typeof document === 'undefined') return false;

  return document.cookie.split(';').some(cookie =>
    cookie.trim().startsWith('auth=true')
  );
};
