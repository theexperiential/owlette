/**
 * Session Management API
 *
 * Handles server-side session creation and destruction with HTTPOnly cookies
 *
 * Routes:
 * - POST /api/auth/session - Create new session (called after Firebase auth)
 * - DELETE /api/auth/session - Destroy session (sign out)
 * - GET /api/auth/session - Get session status (debugging/validation)
 *
 * SECURITY: Rate limited to prevent session creation spam (10 requests/min per IP)
 *
 * MFA enforcement (Wave 2 — server-enforced MFA):
 *   POST bakes `mfaRequired` / `mfaVerified` into the session at create
 *   time from `users/{uid}.mfaEnrolled`. The GET response exposes those
 *   fields so the login page can render the right redirect (the server-side
 *   proxy enforces the gate regardless; the client-side flag is UX only).
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  createSession,
  destroySession,
  getSessionData,
} from '@/lib/sessionManager.server';
import { withRateLimit } from '@/lib/withRateLimit';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';

/**
 * POST /api/auth/session
 * Create a new session after successful Firebase authentication
 *
 * Request Body:
 * {
 *   "userId": "firebase-user-id" (optional, must match idToken),
 *   "idToken": "firebase-id-token",
 *   "durationDays": 7 (optional)
 * }
 *
 * Rate Limited: 10 requests per minute per IP
 */
export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const body = await request.json();
    const { userId, durationDays = 7, idToken } = body;

    // Validate ID token
    if (!idToken || typeof idToken !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid ID token' },
        { status: 400 }
      );
    }

    // Verify Firebase ID token
    let verifiedUserId: string;
    try {
      const adminAuth = getAdminAuth();
      const decoded = await adminAuth.verifyIdToken(idToken);
      verifiedUserId = decoded.uid;
    } catch {
      return NextResponse.json(
        { error: 'Invalid or expired ID token' },
        { status: 401 }
      );
    }

    // Optional userId must match verified token
    if (userId && userId !== verifiedUserId) {
      return NextResponse.json(
        { error: 'User ID does not match token' },
        { status: 403 }
      );
    }

    // Validate durationDays
    if (durationDays && (typeof durationDays !== 'number' || durationDays < 1 || durationDays > 30)) {
      return NextResponse.json(
        { error: 'Invalid duration (must be 1-30 days)' },
        { status: 400 }
      );
    }

    const userDoc = await getAdminDb().collection('users').doc(verifiedUserId).get();
    if (userDoc.exists && typeof userDoc.data()?.deletedAt === 'number') {
      return NextResponse.json(
        { error: 'User is deleted or inactive' },
        { status: 403 }
      );
    }

    // Create session — this internally reads users/{uid}.mfaEnrolled and
    // bakes mfaRequired/mfaVerified into the cookie. The proxy enforces
    // the gate; we don't need to surface those flags in the POST response.
    await createSession(verifiedUserId, durationDays);

    return NextResponse.json({
      success: true,
      message: 'Session created',
      expiresIn: durationDays * 24 * 60 * 60, // seconds
    });
  } catch (error) {
    return apiError(error, 'auth/session POST');
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});

/**
 * DELETE /api/auth/session
 * Destroy the current session (sign out)
 */
export async function DELETE() {
  try {
    await destroySession();

    return NextResponse.json({
      success: true,
      message: 'Session destroyed',
    });
  } catch (error) {
    return apiError(error, 'auth/session DELETE');
  }
}

/**
 * GET /api/auth/session
 * Get current session status (for debugging/validation)
 *
 * Returns:
 * {
 *   "authenticated": boolean,
 *   "userId": string | null,
 *   "expiresAt": number | null,
 *   "mfaRequired": boolean | null,    // null for pre-Wave-2 sessions
 *   "mfaVerified": boolean | null,    // null for pre-Wave-2 sessions
 *   "mfaCompletedAt": number | null
 * }
 *
 * Note: the proxy is the authoritative MFA gate. Clients should treat the
 * MFA fields here as UX hints (e.g. to decide which page to push next),
 * not as a trust boundary.
 */
export async function GET() {
  try {
    const sessionData = await getSessionData();

    if (!sessionData) {
      return NextResponse.json({
        authenticated: false,
        userId: null,
        expiresAt: null,
        mfaRequired: null,
        mfaVerified: null,
        mfaCompletedAt: null,
      });
    }

    return NextResponse.json({
      authenticated: true,
      userId: sessionData.userId,
      expiresAt: sessionData.expiresAt,
      expiresIn: Math.max(0, Math.floor((sessionData.expiresAt - Date.now()) / 1000)), // seconds
      mfaRequired:
        typeof sessionData.mfaRequired === 'boolean'
          ? sessionData.mfaRequired
          : null,
      mfaVerified:
        typeof sessionData.mfaVerified === 'boolean'
          ? sessionData.mfaVerified
          : null,
      mfaCompletedAt: sessionData.mfaCompletedAt ?? null,
    });
  } catch (error) {
    return apiError(error, 'auth/session GET');
  }
}
