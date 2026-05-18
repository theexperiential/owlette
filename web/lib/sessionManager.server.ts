/**
 * Server-Side Session Management with HTTPOnly Cookies
 *
 * SECURITY FEATURES:
 * - HTTPOnly: Prevents JavaScript access (XSS protection)
 * - Secure: Only sent over HTTPS in production
 * - SameSite: CSRF protection
 * - Encrypted: Session data encrypted with secret key
 * - Signed: Tampering detection via iron-session
 *
 * This replaces the client-side session manager (sessionManager.ts) which
 * was vulnerable to XSS cookie theft attacks.
 *
 * MFA enforcement (Wave 2 — server-enforced MFA):
 *   The session carries two MFA state fields stamped at create time:
 *     - `mfaRequired`: cached from `users/{uid}.mfaEnrolled` so the proxy
 *       can decide whether to gate protected paths without a Firestore
 *       lookup on every request.
 *     - `mfaVerified`: set true on session create when no MFA is required,
 *       or after a successful TOTP/backup-code challenge mid-session.
 *   The proxy refuses access to protected paths whenever
 *   `mfaRequired && !mfaVerified`, redirecting to `/verify-2fa`.
 *
 *   Existing sessions issued before Wave 2 do NOT carry these fields. They
 *   are upgraded fail-safe on first proxy hit: see `evaluateSessionMfa()`.
 */

import { getIronSession, IronSession, SessionOptions } from 'iron-session';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';

// Session data structure
export interface SessionData {
  userId: string;
  expiresAt: number;
  /**
   * Cached at session create time from `users/{uid}.mfaEnrolled`. The proxy
   * uses this to decide whether to gate protected paths on the MFA
   * challenge without doing a Firestore lookup on every request.
   *
   * Optional on the type for two reasons:
   *   1. Sessions issued before Wave 2 do not have it. The proxy treats
   *      `undefined` as "look up live in Firestore once and re-mint" via
   *      `evaluateSessionMfa()`.
   *   2. Iron-session deserialises missing keys as `undefined`.
   */
  mfaRequired?: boolean;
  /**
   * Set to true on session create if MFA is not required, OR after a
   * successful TOTP / backup-code / enrollment challenge.
   */
  mfaVerified?: boolean;
  /** Unix ms timestamp of the last successful MFA verification. */
  mfaCompletedAt?: number;
}

// Session configuration
const sessionOptions: SessionOptions = {
  password: process.env.SESSION_SECRET as string,
  cookieName: '__session',
  cookieOptions: {
    httpOnly: true, // Prevents JavaScript access
    secure: process.env.NODE_ENV === 'production', // HTTPS only in production
    sameSite: 'lax', // CSRF protection
    maxAge: 60 * 60 * 24 * 7, // 7 days in seconds
    path: '/',
  },
};

// Validate session secret exists
if (!process.env.SESSION_SECRET) {
  throw new Error(
    'SESSION_SECRET environment variable is required. Generate with: openssl rand -base64 32'
  );
}

if (process.env.SESSION_SECRET.length < 32) {
  throw new Error(
    'SESSION_SECRET must be at least 32 characters long for security'
  );
}

/**
 * Get session from Next.js cookies (App Router)
 * Use this in Server Components and Route Handlers
 */
export async function getSession(): Promise<IronSession<SessionData>> {
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, sessionOptions);
}

/**
 * Get session from Next.js request (Proxy)
 * Use this in proxy.ts
 */
export async function getSessionFromRequest(
  req: NextRequest
): Promise<IronSession<SessionData>> {
  const res = NextResponse.next();
  const session = await getIronSession<SessionData>(req, res, sessionOptions);
  return session;
}

/**
 * Look up `users/{uid}.mfaEnrolled` and derive the (mfaRequired, mfaVerified)
 * pair to bake into a session at create time.
 *
 * - If the user has `mfaEnrolled === true`, require MFA but leave it unverified
 *   (the user must complete the TOTP/backup challenge before any protected
 *   path opens).
 * - If `mfaEnrolled` is falsy OR the user doc does not yet exist (first-login
 *   bootstrap not complete), do not require MFA. Bootstrap will set
 *   `requiresMfaSetup` and the dashboard will nag, but there is nothing to
 *   challenge against until the user actually enrolls.
 *
 * Soft-fail on Firestore errors: if we can't read the user doc, default to
 * `mfaRequired=false, mfaVerified=true`. This is the same posture the system
 * had before Wave 2 (no enforcement at all), so a Firestore outage cannot
 * make the product less secure than its prior baseline, but it also cannot
 * lock a verified user out. Errors are logged so the on-call sees them.
 */
async function resolveMfaStateForUser(userId: string): Promise<{
  mfaRequired: boolean;
  mfaVerified: boolean;
}> {
  try {
    const db = getAdminDb();
    const snap = await db.collection('users').doc(userId).get();
    if (!snap.exists) {
      return { mfaRequired: false, mfaVerified: true };
    }
    const data = snap.data();
    const enrolled = data?.mfaEnrolled === true;
    if (enrolled) {
      return { mfaRequired: true, mfaVerified: false };
    }
    return { mfaRequired: false, mfaVerified: true };
  } catch (err) {
    console.error('[Session] resolveMfaStateForUser failed for', userId, err);
    return { mfaRequired: false, mfaVerified: true };
  }
}

/**
 * Create a new session
 * @param userId - Firebase user ID
 * @param durationDays - Session duration in days (default: 7)
 *
 * Reads `users/{uid}.mfaEnrolled` synchronously so the session is born with
 * the correct (mfaRequired, mfaVerified) pair. A small extra cost on login
 * (one Firestore read) in exchange for the proxy never having to do that
 * lookup on the hot path.
 */
export async function createSession(
  userId: string,
  durationDays: number = 7
): Promise<void> {
  const session = await getSession();

  const expiresAt = Date.now() + durationDays * 24 * 60 * 60 * 1000;
  const { mfaRequired, mfaVerified } = await resolveMfaStateForUser(userId);

  session.userId = userId;
  session.expiresAt = expiresAt;
  session.mfaRequired = mfaRequired;
  session.mfaVerified = mfaVerified;
  if (mfaVerified && !mfaRequired) {
    // First-login / no-MFA users are "verified" at creation but never
    // completed a challenge. `mfaCompletedAt` would be misleading there;
    // omit it.
    delete session.mfaCompletedAt;
  } else {
    delete session.mfaCompletedAt;
  }

  await session.save();

  console.log(
    '[Session] Created for user:', userId,
    'expires:', new Date(expiresAt).toISOString(),
    'mfaRequired:', mfaRequired,
    'mfaVerified:', mfaVerified
  );
}

/**
 * Validate session (check expiration)
 * @returns userId if valid, null if invalid/expired
 */
export async function validateSession(): Promise<string | null> {
  const session = await getSession();

  if (!session.userId || !session.expiresAt) {
    return null;
  }

  // Check if session has expired
  if (Date.now() > session.expiresAt) {
    console.warn('[Session] Expired session detected:', session.userId);
    await destroySession();
    return null;
  }

  return session.userId;
}

/**
 * Validate session from request (proxy)
 * @returns userId if valid, null if invalid/expired
 */
export async function validateSessionFromRequest(
  req: NextRequest
): Promise<string | null> {
  const session = await getSessionFromRequest(req);

  if (!session.userId || !session.expiresAt) {
    return null;
  }

  // Check if session has expired
  if (Date.now() > session.expiresAt) {
    console.warn('[Session] Expired session detected in proxy:', session.userId);
    await session.destroy();
    return null;
  }

  return session.userId;
}

/**
 * Proxy-side MFA gate evaluation.
 *
 * Returns one of three outcomes:
 *   - `pass`: session is authenticated and MFA is satisfied (or not required).
 *   - `challenge`: session is authenticated but MFA is required and not yet
 *     verified. The proxy should redirect to `/verify-2fa?redirect=...`.
 *   - `unauthenticated`: no valid session. The proxy treats this as before.
 *
 * Backward-compat for pre-Wave-2 sessions: a session that has a valid
 * `userId`/`expiresAt` but no `mfaRequired` field is upgraded fail-safe.
 * We look up `users/{uid}.mfaEnrolled` once, write the result back into the
 * session, and save. After that one upgrade, the session carries the field
 * and no further Firestore reads happen on the hot path.
 *
 * Trade-off: pre-Wave-2 sessions pay a one-time Firestore round-trip on
 * first protected-page hit after deploy. If Firestore is unavailable at
 * that exact moment we fall back to "MFA not required" (matching the
 * pre-Wave-2 behaviour) rather than locking the user out. This is the
 * same posture `resolveMfaStateForUser` uses for ordinary session creation.
 *
 * The proxy never destroys a session here; we only either pass through or
 * redirect to the challenge page.
 */
export async function evaluateSessionMfa(
  req: NextRequest
): Promise<{
  outcome: 'pass' | 'challenge' | 'unauthenticated';
  userId: string | null;
}> {
  const session = await getSessionFromRequest(req);

  if (!session.userId || !session.expiresAt) {
    return { outcome: 'unauthenticated', userId: null };
  }

  if (Date.now() > session.expiresAt) {
    await session.destroy();
    return { outcome: 'unauthenticated', userId: null };
  }

  // Migrate pre-Wave-2 sessions: no `mfaRequired` field means the session
  // was issued before this feature shipped. Upgrade in place.
  if (typeof session.mfaRequired !== 'boolean') {
    const { mfaRequired, mfaVerified } = await resolveMfaStateForUser(
      session.userId
    );
    session.mfaRequired = mfaRequired;
    session.mfaVerified = mfaVerified;
    try {
      await session.save();
    } catch (err) {
      // If we can't persist the upgrade, still honor the freshly-evaluated
      // values for this request — better to enforce than to no-op.
      console.error('[Session] failed to persist MFA upgrade for', session.userId, err);
    }
  }

  if (session.mfaRequired && !session.mfaVerified) {
    return { outcome: 'challenge', userId: session.userId };
  }

  return { outcome: 'pass', userId: session.userId };
}

/**
 * Destroy session (sign out)
 */
export async function destroySession(): Promise<void> {
  const session = await getSession();
  const userId = session.userId;

  session.destroy();

  if (userId) {
    console.log('[Session] Destroyed for user:', userId);
  }
}

/**
 * Extend session expiration (sliding expiration)
 * Call this on each request to keep active users signed in
 */
export async function extendSession(durationDays: number = 7): Promise<void> {
  const session = await getSession();

  if (!session.userId) {
    return; // No session to extend
  }

  const expiresAt = Date.now() + durationDays * 24 * 60 * 60 * 1000;
  session.expiresAt = expiresAt;

  await session.save();
}

/**
 * Mark the current session as having completed an MFA challenge.
 *
 * Called from:
 *   - `/api/mfa/verify-login` after a successful TOTP / backup-code check.
 *   - `/api/mfa/verify-setup` after the user completes initial enrollment
 *     (the enrollment itself counts as a fresh verification).
 *
 * No-op when the session has no `userId` — callers should have already
 * established the session via `requireSessionUser` before calling this.
 */
export async function markSessionMfaVerified(): Promise<void> {
  const session = await getSession();
  if (!session.userId) {
    return;
  }
  session.mfaRequired = true;
  session.mfaVerified = true;
  session.mfaCompletedAt = Date.now();
  await session.save();
}

/**
 * Re-mint the current session's MFA state after a server-mediated MFA
 * disable. The just-completed disable is treated as a verification event
 * so the user stays signed in without an immediate re-challenge.
 */
export async function markSessionMfaDisabled(): Promise<void> {
  const session = await getSession();
  if (!session.userId) {
    return;
  }
  session.mfaRequired = false;
  session.mfaVerified = true;
  session.mfaCompletedAt = Date.now();
  await session.save();
}

/**
 * Get session data without modifying it
 * Useful for reading session in Server Components
 */
export async function getSessionData(): Promise<SessionData | null> {
  const session = await getSession();

  if (!session.userId || !session.expiresAt) {
    return null;
  }

  // Check expiration
  if (Date.now() > session.expiresAt) {
    return null;
  }

  const data: SessionData = {
    userId: session.userId,
    expiresAt: session.expiresAt,
  };
  if (typeof session.mfaRequired === 'boolean') {
    data.mfaRequired = session.mfaRequired;
  }
  if (typeof session.mfaVerified === 'boolean') {
    data.mfaVerified = session.mfaVerified;
  }
  if (typeof session.mfaCompletedAt === 'number') {
    data.mfaCompletedAt = session.mfaCompletedAt;
  }
  return data;
}
