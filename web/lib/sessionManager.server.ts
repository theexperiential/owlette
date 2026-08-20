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
 *     - `mfaVerified`: `mfaRequired` is always re-derived fresh from
 *       Firestore, but `mfaVerified` is NOT blindly reset on every create.
 *       When MFA is required, `createSession` preserves a prior verified
 *       state (same uid, unexpired, prior session actually passed a
 *       challenge) so AuthContext's every-load `POST /api/auth/session`
 *       stops clobbering `mfaVerified` on page loads. It can also be born
 *       verified via a valid device-trust cookie ("remember this device for
 *       30 days"), or via a user-verified passkey ceremony the calling route
 *       just completed (`mfaSatisfiedBy: 'passkey-uv'`). See
 *       `resolveMfaOnSessionCreate()` for the exact rule.
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
import {
  DEVICE_TRUST_COOKIE,
  findValidTrustedDevice,
} from '@/lib/deviceTrust.server';

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
  // Note: the previous version of this function fail-opened on Firestore
  // errors (returned mfaRequired:false). An attacker who could induce
  // even a transient Firestore failure during their session creation
  // could thereby bypass MFA. We now THROW on error; callers decide how
  // to handle (createSession lets it propagate; evaluateSessionMfa
  // catches and forces a challenge — fail-CLOSED).
  //
  // The doc-not-exists case is still fail-soft for legitimate reasons:
  // first-login users may hit evaluateSessionMfa before /api/users/bootstrap
  // has run. Those users can't have MFA enrolled (they have no doc), so
  // mfaRequired=false is correct.
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
}

/**
 * True when the prior session proves an MFA challenge was actually cleared for
 * THIS user in a still-live session — the exact precondition for preserving a
 * verified state across AuthContext's every-load re-POST of `/api/auth/session`.
 *
 * Both `prev.mfaRequired === true` AND `prev.mfaVerified === true` are demanded
 * because that pairing is the only one a real challenge produces. It
 * deliberately excludes:
 *   - post-disable sessions (`mfaRequired=false, mfaVerified=true`), and
 *   - pre-enrollment / no-MFA sessions (`mfaRequired=false`),
 * neither of which should let a newly-required session skip the challenge.
 *
 * Extracted as the single source of truth for the preserve condition so
 * `createSession` (which uses it to gate the device-trust I/O) and
 * `resolveMfaOnSessionCreate` (which uses it to decide the field values) can
 * never drift apart.
 */
function canPreserveVerifiedMfa(
  prev: {
    userId?: string;
    expiresAt?: number;
    mfaRequired?: boolean;
    mfaVerified?: boolean;
  },
  userId: string,
  now: number
): boolean {
  return (
    prev.userId === userId &&
    typeof prev.expiresAt === 'number' &&
    prev.expiresAt > now &&
    prev.mfaRequired === true &&
    prev.mfaVerified === true
  );
}

/**
 * Pure decision function for the `(mfaVerified, mfaCompletedAt)` a session
 * should be born with. `mfaRequired` is always taken verbatim from `resolved`
 * (the fresh Firestore truth); this helper only decides the verification state,
 * so it can be unit-tested without any iron-session / Firestore mocks.
 *
 * The verified outcomes, in priority order:
 *
 *   1. NOT required (`resolved.mfaRequired === false`) → verified, but WITHOUT
 *      `mfaCompletedAt`. No-MFA / first-login users are "verified" at creation
 *      yet never completed a challenge, so a completion timestamp would be
 *      misleading (preserves the historical no-MFA behaviour).
 *
 *   2. PRESERVE (`canPreserveVerifiedMfa`) → required, and the prior session
 *      proves a challenge was already cleared for this uid and is still live.
 *      Verified, carrying `prev.mfaCompletedAt` forward so the original
 *      completion time survives AuthContext's every-load re-POST.
 *
 *   3. PASSKEY-UV (`mfaSatisfiedBy === 'passkey-uv'`) → required, preserve did
 *      not apply, but the CALLING ROUTE just completed a WebAuthn ceremony
 *      under `requireUserVerification: true`. That single ceremony proved
 *      possession of the credential AND verification of the user
 *      (PIN/biometric), which is exactly what makes one passkey login
 *      multi-factor. Verified, with `mfaCompletedAt = now` — the ceremony is
 *      itself a fresh verification event.
 *
 *   4. DEVICE TRUST (`deviceTrusted`) → required, neither of the above applied,
 *      but a valid `owlette_device_trust` cookie was found for this uid. The
 *      grant IS a fresh verification event, so `mfaCompletedAt = now`.
 *
 * Otherwise (required, no preserve, no passkey ceremony, untrusted device) →
 * NOT verified, forcing the `/verify-2fa` challenge; no `mfaCompletedAt`.
 * Preserve outranks both birth paths, so when it applies the completion time
 * comes from `prev`, not `now`.
 *
 * How `mfaSatisfiedBy` interacts with the two pre-existing rules — worked out
 * deliberately, not incidental to where the branch happens to sit:
 *   - vs PRESERVE: preserve is still checked FIRST and is untouched. When both
 *     apply (an already-verified, still-live session re-authenticating with a
 *     passkey) the verification outcome is identical either way; only the
 *     timestamp would differ, and the established rule — the ORIGINAL
 *     completion time survives AuthContext's every-load re-POST — keeps
 *     precedence. Ordering passkey-uv above preserve would silently rewrite
 *     `mfaCompletedAt` on that path for no security gain.
 *   - vs DEVICE TRUST: both sit below preserve and return byte-identical
 *     output, so their relative order is unobservable. Passkey-uv reads first
 *     because it is a verification the server just witnessed, rather than one
 *     it is remembering from an earlier session.
 *   - NEITHER IS WEAKENED: `mfaSatisfiedBy` is consulted only inside the
 *     `resolved.mfaRequired === true` arm, so it can never flip `mfaRequired`
 *     (still the fresh Firestore truth), and a not-required account resolves
 *     exactly as it did before.
 *   - It needs no stickiness: a passkey-born session satisfies
 *     `canPreserveVerifiedMfa`, so AuthContext's subsequent
 *     `POST /api/auth/session` — which passes no `mfaSatisfiedBy` — preserves
 *     the verified state instead of re-challenging the user.
 */
export function resolveMfaOnSessionCreate(input: {
  prev: {
    userId?: string;
    expiresAt?: number;
    mfaRequired?: boolean;
    mfaVerified?: boolean;
    mfaCompletedAt?: number;
  };
  resolved: { mfaRequired: boolean; mfaVerified: boolean };
  userId: string;
  now: number;
  deviceTrusted: boolean;
  /**
   * SERVER-SIDE ONLY — see the security note on `createSession`'s parameter of
   * the same name. Set only by a route that itself performed the ceremony.
   */
  mfaSatisfiedBy?: 'passkey-uv';
}): { mfaRequired: boolean; mfaVerified: boolean; mfaCompletedAt?: number } {
  const { prev, resolved, userId, now, deviceTrusted, mfaSatisfiedBy } = input;

  // mfaRequired is always the fresh Firestore truth.
  if (!resolved.mfaRequired) {
    // Not required → verified, but no completion timestamp (outcome #1).
    return { mfaRequired: false, mfaVerified: true };
  }

  // Required. Preserve a prior, genuinely-challenged, still-live session.
  if (canPreserveVerifiedMfa(prev, userId, now)) {
    return {
      mfaRequired: true,
      mfaVerified: true,
      mfaCompletedAt: prev.mfaCompletedAt,
    };
  }

  // Required, no preserve. A user-verified WebAuthn ceremony completed during
  // THIS request satisfies the challenge outright (outcome #3): the verifying
  // route pins `requireUserVerification: true`, so reaching here means the
  // authenticator checked the human as well as the credential. Fresh event →
  // `now`.
  if (mfaSatisfiedBy === 'passkey-uv') {
    return { mfaRequired: true, mfaVerified: true, mfaCompletedAt: now };
  }

  // Required, no preserve, no ceremony. A valid device-trust cookie births a
  // verified session; the grant is itself a fresh verification event.
  if (deviceTrusted) {
    return { mfaRequired: true, mfaVerified: true, mfaCompletedAt: now };
  }

  // Required, and nothing satisfied it → challenge.
  return { mfaRequired: true, mfaVerified: false };
}

/**
 * Create a new session
 * @param userId - Firebase user ID
 * @param durationDays - Session duration in days (default: 7)
 * @param mfaSatisfiedBy - SERVER-SIDE ONLY. Pass `'passkey-uv'` when the
 *   CALLING ROUTE has itself just completed a WebAuthn ceremony verified with
 *   `requireUserVerification: true`. This value must NEVER be derived from
 *   anything the client controls — not a request body field, query param,
 *   header, or cookie — because it is the one input that can birth a session
 *   `mfaVerified` without a challenge; sourcing it from the request would be an
 *   MFA bypass with a one-word payload. A reviewer confirms that by grepping
 *   the two (and only two) call sites: `app/api/auth/session/route.ts`, which
 *   never passes it, and `app/api/passkeys/authenticate/verify/route.ts`, which
 *   passes the string literal unconditionally after `verification.verified`.
 *
 * Reads `users/{uid}.mfaEnrolled` synchronously so the session is born with the
 * correct `mfaRequired`. `mfaRequired` is ALWAYS re-derived fresh from
 * Firestore, but `mfaVerified` is NOT blindly reset:
 *
 *   - PRESERVE: when MFA is required and the prior cookie proves a challenge was
 *     already cleared for this uid in a still-live session
 *     (`canPreserveVerifiedMfa`), the verified state — and its original
 *     `mfaCompletedAt` — carry forward. This stops AuthContext's every-load
 *     `POST /api/auth/session` from clobbering `mfaVerified` on page loads.
 *   - PASSKEY-UV: otherwise, when MFA is required and the caller passes
 *     `mfaSatisfiedBy: 'passkey-uv'`, the session is born `mfaVerified: true`
 *     with `mfaCompletedAt = now`. One user-verified passkey ceremony is both
 *     factors, so such a login must not also be sent to `/verify-2fa`.
 *   - DEVICE TRUST: otherwise, when MFA is required, the `owlette_device_trust`
 *     cookie is consulted (only then — never when preserve or passkey-uv has
 *     already settled it, and never when MFA isn't required, so neither path
 *     pays for the lookup). A valid, unexpired record under this uid births the
 *     session `mfaVerified: true` with `mfaCompletedAt = now`.
 *
 * See `resolveMfaOnSessionCreate` for the exact rule. The device-trust cookie is
 * read internally rather than passed in, so every caller picks that path up
 * unchanged; `mfaSatisfiedBy` is the one explicit caller assertion, because only
 * the calling route can know that a ceremony just succeeded.
 *
 * Fail-closed: any error reading/looking up the device-trust cookie is caught
 * and treated as untrusted (a challenge). `resolveMfaStateForUser`'s own throw
 * still propagates exactly as before — a Firestore failure resolving MFA state
 * must never silently mint a session.
 */
export async function createSession(
  userId: string,
  durationDays: number = 7,
  mfaSatisfiedBy?: 'passkey-uv'
): Promise<void> {
  const session = await getSession();

  // Capture the PRIOR session's MFA-relevant fields BEFORE overwriting anything
  // below — the preserve rule reads these to decide whether an already-verified
  // session stays verified across AuthContext's every-load re-POST.
  const prev = {
    userId: session.userId,
    expiresAt: session.expiresAt,
    mfaRequired: session.mfaRequired,
    mfaVerified: session.mfaVerified,
    mfaCompletedAt: session.mfaCompletedAt,
  };

  const now = Date.now();
  const expiresAt = now + durationDays * 24 * 60 * 60 * 1000;

  // Fresh Firestore truth. resolveMfaStateForUser stays fail-closed/throwing;
  // let its throw propagate exactly as before (never swallow it here).
  const resolved = await resolveMfaStateForUser(userId);

  // Preserve and passkey-uv are both I/O-free, so decide them first: only read
  // the device-trust cookie when MFA is required AND neither of the two
  // higher-precedence paths has already settled the verified state. Skipping
  // the lookup here is behaviour-neutral — `resolveMfaOnSessionCreate` returns
  // from those branches before it ever reads `deviceTrusted` — and it saves a
  // Firestore round-trip on every passkey login.
  let deviceTrusted = false;
  if (
    resolved.mfaRequired &&
    !canPreserveVerifiedMfa(prev, userId, now) &&
    mfaSatisfiedBy !== 'passkey-uv'
  ) {
    // Fail-CLOSED: ANY error reading the cookie or looking up the record means
    // untrusted → challenge. Logged so on-call sees it, but the error must
    // never escape createSession through this path, and must never flip an
    // untrusted device into a trusted one.
    try {
      const cookieStore = await cookies();
      const raw = cookieStore.get(DEVICE_TRUST_COOKIE)?.value;
      if (raw) {
        deviceTrusted = await findValidTrustedDevice(userId, raw, now);
      }
    } catch (err) {
      console.error(
        '[Session] device-trust lookup failed for',
        userId,
        '— treating device as untrusted (fail-closed)',
        err
      );
      deviceTrusted = false;
    }
  }

  const mfa = resolveMfaOnSessionCreate({
    prev,
    resolved,
    userId,
    now,
    deviceTrusted,
    mfaSatisfiedBy,
  });

  session.userId = userId;
  session.expiresAt = expiresAt;
  session.mfaRequired = mfa.mfaRequired;
  session.mfaVerified = mfa.mfaVerified;
  if (typeof mfa.mfaCompletedAt === 'number') {
    session.mfaCompletedAt = mfa.mfaCompletedAt;
  } else {
    // No-MFA, freshly-challenged-elsewhere, or unverified: no completion
    // timestamp to carry. Clear any stale value from a reused cookie.
    delete session.mfaCompletedAt;
  }

  await session.save();

  console.log(
    '[Session] Created for user:', userId,
    'expires:', new Date(expiresAt).toISOString(),
    'mfaRequired:', mfa.mfaRequired,
    'mfaVerified:', mfa.mfaVerified,
    'deviceTrusted:', deviceTrusted,
    'mfaSatisfiedBy:', mfaSatisfiedBy ?? 'none'
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
  //
  // If the Firestore lookup throws (transient outage), we DO NOT cache a
  // result — we force `challenge` for this request and leave the session
  // unmodified so a retry can complete the upgrade later. This is the
  // fail-CLOSED path (previously fail-open, which let an attacker bypass
  // MFA by exploiting a transient Firestore failure).
  if (typeof session.mfaRequired !== 'boolean') {
    try {
      const { mfaRequired, mfaVerified } = await resolveMfaStateForUser(
        session.userId,
      );
      session.mfaRequired = mfaRequired;
      session.mfaVerified = mfaVerified;
      try {
        await session.save();
      } catch (err) {
        // If we can't persist the upgrade, still honor the freshly-evaluated
        // values for this request — better to enforce than to no-op.
        console.error(
          '[Session] failed to persist MFA upgrade for',
          session.userId,
          err,
        );
      }
    } catch (err) {
      console.error(
        '[Session] MFA upgrade lookup failed for',
        session.userId,
        '— forcing challenge (fail-closed)',
        err,
      );
      // Force the challenge path so we don't fail-OPEN. The session is
      // unmodified; the next request will retry the upgrade.
      return { outcome: 'challenge', userId: session.userId };
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
