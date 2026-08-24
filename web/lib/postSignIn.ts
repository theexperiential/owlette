/**
 * Where to send a user right after a Firebase sign-in.
 *
 * Client sign-in does not authenticate the SERVER: `AuthContext` mints the
 * `__session` cookie from `onAuthStateChanged` without awaiting it, so for a
 * short window the Firebase user exists and the cookie does not — navigating
 * inside it makes `proxy.ts` bounce to `/login?redirect=`, which reads as a
 * silently failed sign-in. /register raced this every time before this module;
 * one settle-and-poll now serves both pages.
 *
 * UX hint only — `proxy.ts` is the authoritative auth + MFA gate.
 */

/** Let onAuthStateChanged fire and start minting the cookie before we poll. */
const SETTLE_MS = 500;
const MAX_ATTEMPTS = 5;
const RETRY_MS = 150;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `settleMs: 0` when the caller already holds a server session — the passkey
 * verify route mints the cookie before returning, so settling is dead latency.
 */
export async function resolvePostSignInPath(
  fallbackPath: string,
  settleMs: number = SETTLE_MS,
): Promise<string> {
  if (settleMs > 0) await delay(settleMs);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch('/api/auth/session', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        if (data.authenticated === true) {
          if (data.mfaRequired === true && data.mfaVerified !== true) {
            return `/verify-2fa?redirect=${encodeURIComponent(fallbackPath)}`;
          }
          return fallbackPath;
        }
      }
    } catch (err) {
      // Network blip — fall through to the retry.
      console.warn('[postSignIn] session probe failed (will retry):', err);
    }
    await delay(RETRY_MS);
  }

  // Never saw a session — go anyway and let the proxy route to /login or
  // /verify-2fa.
  return fallbackPath;
}
