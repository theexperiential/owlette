/**
 * @deprecated Client-side session manager — DO NOT USE IN NEW CODE.
 *
 * Client-set cookies are readable by XSS; replaced by lib/sessionManager.server.ts
 * (HTTPOnly, encrypted) behind app/api/auth/session/route.ts, used by
 * contexts/AuthContext.tsx and proxy.ts. Kept only for backward compatibility.
 * Migration completed 2025-11-17.
 */

/** Sets the session cookie the proxy checks for route protection. */
export const setSessionCookie = (userId: string, expirationDays: number = 7): void => {
  if (typeof window === 'undefined') return;

  const expirationDate = new Date();
  expirationDate.setDate(expirationDate.getDate() + expirationDays);

  const isSecure = window.location.protocol === 'https:';
  const secureFlag = isSecure ? '; Secure' : '';

  // Plaintext uid — production should carry an encrypted token instead.
  document.cookie = `__session=${userId}; expires=${expirationDate.toUTCString()}; path=/; SameSite=Lax${secureFlag}`;

  // Indicator cookie the proxy reads.
  document.cookie = `auth=true; expires=${expirationDate.toUTCString()}; path=/; SameSite=Lax${secureFlag}`;
};

/** Clears the session cookie on logout. */
export const clearSessionCookie = (): void => {
  if (typeof window === 'undefined') return;

  document.cookie = '__session=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; SameSite=Lax';
  document.cookie = 'auth=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; SameSite=Lax';
};

/** Client-side presence check for the session cookie. */
export const hasSessionCookie = (): boolean => {
  if (typeof document === 'undefined') return false;

  return document.cookie.split(';').some(cookie =>
    cookie.trim().startsWith('auth=true')
  );
};
