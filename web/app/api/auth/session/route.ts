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
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  createSession,
  destroySession,
  getSessionData,
} from '@/lib/sessionManager.server';
import { withRateLimit } from '@/lib/withRateLimit';
import { getAdminAuth } from '@/lib/firebase-admin';
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
    } catch (error) {
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

    // Create session
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
 *   "expiresAt": number | null
 * }
 */
export async function GET() {
  try {
    const sessionData = await getSessionData();

    if (!sessionData) {
      return NextResponse.json({
        authenticated: false,
        userId: null,
        expiresAt: null,
      });
    }

    return NextResponse.json({
      authenticated: true,
      userId: sessionData.userId,
      expiresAt: sessionData.expiresAt,
      expiresIn: Math.max(0, Math.floor((sessionData.expiresAt - Date.now()) / 1000)), // seconds
    });
  } catch (error) {
    return apiError(error, 'auth/session GET');
  }
}
