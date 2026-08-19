/**
 * Where to send a user immediately after a successful Firebase sign-in.
 *
 * WHY THIS IS SHARED
 * ------------------
 * Signing in client-side does NOT make the user authenticated as far as the
 * server is concerned. `AuthContext` mints the `__session` cookie from its
 * `onAuthStateChanged` listener and does not await it, so for a short window
 * the Firebase user exists but the cookie does not. Navigating to a protected
 * path inside that window means `proxy.ts` sees an unauthenticated request and
 * bounces to `/login?redirect=<path>` — the sign-in looks like it silently
 * failed, and the user lands back where they started.
 *
 * /login had a settle-and-poll for exactly this reason. /register did not, and
 * pushed to /dashboard the instant the popup resolved — so a Google signup
 * raced the cookie every time, and lost on a slow connection. That drift is
 * the whole bug this module exists to prevent: one implementation, both pages.
 *
 * This is a UX hint only. `proxy.ts` is the authoritative auth + MFA gate; the
 * worst case here is that we guess wrong and the proxy corrects us.
 */

/** Let onAuthStateChanged fire and start minting the cookie before we poll. */
const SETTLE_MS = 500;
const MAX_ATTEMPTS = 5;
const RETRY_MS = 150;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param fallbackPath where the user was trying to go
 * @param settleMs     pass 0 when the caller already holds a server session.
 *                     The passkey flow does: its verify route mints the cookie
 *                     before returning, so the settle would be dead latency on
 *                     a flow whose whole appeal is feeling instant.
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

  // Never saw an authenticated session. Go to the target anyway and let the
  // proxy decide — it will route to /login or /verify-2fa as appropriate.
  return fallbackPath;
}
