import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { withRateLimit } from '@/lib/withRateLimit';
import logger from '@/lib/logger';

/**
 * POST /api/agent/auth/refresh
 *
 * Refresh an expired access token using a refresh token.
 * Custom tokens expire after 1 hour, so agents must refresh periodically.
 *
 * Request body:
 * - refreshToken: string - Long-lived refresh token from initial exchange
 * - machineId: string - Machine identifier (for validation)
 *
 * Response (200 OK):
 * - accessToken: string - New OAuth 2.0 access token for Firestore API (1 hour expiry)
 * - expiresIn: number - Access token expiry in seconds (3600)
 *
 * Errors:
 * - 400: Missing required fields
 * - 401: Invalid refresh token, or expired (if token has expiresAt set)
 * - 403: Machine ID mismatch (security check)
 * - 429: Rate limit exceeded (20 requests per hour per IP)
 * - 500: Server error
 *
 * Note: Tokens without expiresAt field never expire (for long-duration installations)
 *
 * SECURITY: Rate limited to prevent token refresh spam
 */
export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    // Parse request body
    const body = await request.json();
    const { refreshToken, machineId } = body;

    if (!refreshToken || !machineId) {
      return NextResponse.json(
        { error: 'Missing required fields: refreshToken, machineId' },
        { status: 400 }
      );
    }

    // Hash the refresh token (stored hashed for security)
    const crypto = await import('crypto');
    const refreshTokenHash = crypto.createHash('sha256')
      .update(refreshToken)
      .digest('hex');

    // Validate refresh token and update lastUsed atomically via transaction.
    // This prevents concurrent refresh requests from creating inconsistent state.
    const adminDb = getAdminDb();
    const tokenRef = adminDb.collection('agent_refresh_tokens').doc(refreshTokenHash);

    let siteId: string;
    let version: string;
    let agentUid: string;

    try {
      const result = await adminDb.runTransaction(async (transaction) => {
        const tokenDoc = await transaction.get(tokenRef);

        if (!tokenDoc.exists) {
          return { error: 'Invalid refresh token', status: 401 } as const;
        }

        const tokenData = tokenDoc.data();

        // Check expiry (tokens without expiresAt never expire — by design for long-duration installations)
        const now = Date.now();
        const expiresAt = tokenData?.expiresAt?.toMillis();

        if (expiresAt && expiresAt < now) {
          transaction.delete(tokenRef);
          return { error: 'Refresh token expired. Please re-authenticate.', status: 401 } as const;
        }

        // Verify machine ID matches (prevent token theft)
        if (tokenData?.machineId !== machineId) {
          console.warn(
            `Machine ID mismatch for refresh token: ` +
            `expected=${tokenData?.machineId}, got=${machineId}`
          );
          return { error: 'Machine ID mismatch. Token may be compromised.', status: 403 } as const;
        }

        const txSiteId = tokenData?.siteId as string;
        const txVersion = tokenData?.version as string;
        const txAgentUid = tokenData?.agentUid as string;

        if (!txSiteId || !txVersion || !txAgentUid) {
          return { error: 'Invalid refresh token data', status: 401 } as const;
        }

        // Atomically update lastUsed inside the transaction
        transaction.update(tokenRef, {
          lastUsed: FieldValue.serverTimestamp(),
        });

        return { siteId: txSiteId, version: txVersion, agentUid: txAgentUid } as const;
      });

      if ('error' in result) {
        return NextResponse.json({ error: result.error }, { status: result.status });
      }

      siteId = result.siteId;
      version = result.version;
      agentUid = result.agentUid;
    } catch (txError: any) {
      logger.warn(`Refresh token transaction failed: ${txError.message}`);
      return NextResponse.json(
        { error: 'Token refresh failed. Please try again.' },
        { status: 500 }
      );
    }

    // Generate new Firebase Custom Token for agent (outside transaction — safe, idempotent)
    const adminAuth = getAdminAuth();

    // CRITICAL: Ensure custom claims are set on the user account
    // This guarantees the claims persist across token refreshes
    await adminAuth.setCustomUserClaims(agentUid, {
      role: 'agent',
      site_id: siteId,
      machine_id: machineId,
      version,
    });

    const customToken = await adminAuth.createCustomToken(agentUid, {
      role: 'agent',
      site_id: siteId,
      machine_id: machineId,
      version,
    });

    // Exchange custom token for ID token (required for Firestore REST API)
    // This uses Firebase Auth REST API to convert the custom token
    const firebaseApiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
    if (!firebaseApiKey) {
      throw new Error('Firebase API key not configured');
    }

    const authResponse = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${firebaseApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: customToken, returnSecureToken: true }),
      }
    );

    if (!authResponse.ok) {
      const errorData = await authResponse.json();
      throw new Error(`Failed to exchange custom token: ${errorData.error?.message || 'Unknown error'}`);
    }

    const authData = await authResponse.json();
    const idToken = authData.idToken; // This token now has the custom claims

    // lastUsed was already updated atomically inside the transaction above.

    logger.info(`Token refreshed: site=${siteId}, machine=${machineId}`);

    return NextResponse.json(
      {
        accessToken: idToken,
        expiresIn: 3600, // 1 hour in seconds
      },
      { status: 200 }
    );

  } catch (error: any) {
    console.error('Error refreshing token:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}, {
  strategy: 'tokenRefresh',
  identifier: 'ip',
});
