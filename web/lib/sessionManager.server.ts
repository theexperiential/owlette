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
 */

import { getIronSession, IronSession, SessionOptions } from 'iron-session';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

// Session data structure
export interface SessionData {
  userId: string;
  expiresAt: number;
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
 * Create a new session
 * @param userId - Firebase user ID
 * @param durationDays - Session duration in days (default: 7)
 */
export async function createSession(
  userId: string,
  durationDays: number = 7
): Promise<void> {
  const session = await getSession();

  const expiresAt = Date.now() + durationDays * 24 * 60 * 60 * 1000;

  session.userId = userId;
  session.expiresAt = expiresAt;

  await session.save();

  console.log('[Session] Created for user:', userId, 'expires:', new Date(expiresAt).toISOString());
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

  return {
    userId: session.userId,
    expiresAt: session.expiresAt,
  };
}
