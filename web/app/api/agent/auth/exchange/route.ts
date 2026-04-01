import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import admin from '@/lib/firebase-admin';
import { withRateLimit } from '@/lib/withRateLimit';
import logger from '@/lib/logger';

/**
 * POST /api/agent/auth/exchange
 *
 * Exchange a registration code for authentication tokens.
 * This is the first step in the agent OAuth flow - the registration code
 * is embedded in the installer and exchanged for a custom token + refresh token.
 *
 * Request body:
 * - registrationCode: string - One-time registration code from installer
 * - machineId: string - Unique machine identifier (hostname)
 * - version: string - Agent version (e.g., "2.0.0")
 *
 * Response (200 OK):
 * - accessToken: string - OAuth 2.0 access token for Firestore API (1 hour expiry)
 * - refreshToken: string - Long-lived refresh token (never expires, can be revoked by admin)
 * - expiresIn: number - Access token expiry in seconds (3600)
 * - siteId: string - Site ID this agent is authorized for
 *
 * Errors:
 * - 400: Missing required fields
 * - 401: Invalid or expired registration code
 * - 429: Rate limit exceeded (20 attempts per hour per IP)
 * - 500: Server error
 *
 * SECURITY: Rate limited to prevent brute force token exchange attempts
 */
export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    // Parse request body
    const body = await request.json();
    const { registrationCode, machineId, version } = body;

    if (!registrationCode || !machineId || !version) {
      return NextResponse.json(
        { error: 'Missing required fields: registrationCode, machineId, version' },
        { status: 400 }
      );
    }

    // Validate registration code in Firestore
    const adminDb = getAdminDb();
    const tokenRef = adminDb.collection('agent_tokens').doc(registrationCode);
    const tokenDoc = await tokenRef.get();

    if (!tokenDoc.exists) {
      return NextResponse.json(
        { error: 'Invalid registration code' },
        { status: 401 }
      );
    }

    const tokenData = tokenDoc.data();

    // Check if code has already been used
    if (tokenData?.used) {
      return NextResponse.json(
        { error: 'Registration code already used' },
        { status: 401 }
      );
    }

    // Check if code has expired (24 hours from creation)
    const now = Date.now();
    const expiresAt = tokenData?.expiresAt?.toMillis();

    if (!expiresAt || expiresAt < now) {
      return NextResponse.json(
        { error: 'Registration code expired' },
        { status: 401 }
      );
    }

    const siteId = tokenData?.siteId as string;
    const createdBy = tokenData?.createdBy as string;

    if (!siteId || !createdBy) {
      return NextResponse.json(
        { error: 'Invalid registration code data' },
        { status: 401 }
      );
    }

    // Generate unique agent user ID
    const agentUid = `agent_${siteId}_${machineId}`.replace(/[^a-zA-Z0-9_]/g, '_');

    // Generate Firebase Custom Token for agent
    const adminAuth = getAdminAuth();
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
    const idToken = authData.idToken;

    // CRITICAL: Set custom claims on the user account
    // Custom token claims are NOT automatically persisted - must explicitly set them
    // This ensures future ID tokens contain the required claims for Firestore security rules
    await adminAuth.setCustomUserClaims(agentUid, {
      role: 'agent',
      site_id: siteId,
      machine_id: machineId,
      version,
    });

    // Force token refresh to get ID token with custom claims
    // The previous ID token won't have the claims until we refresh
    // We need to create a NEW custom token and exchange it again
    const customTokenWithClaims = await adminAuth.createCustomToken(agentUid, {
      role: 'agent',
      site_id: siteId,
      machine_id: machineId,
      version,
    });

    const refreshAuthResponse = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${firebaseApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: customTokenWithClaims, returnSecureToken: true }),
      }
    );

    if (!refreshAuthResponse.ok) {
      const errorData = await refreshAuthResponse.json();
      throw new Error(`Failed to refresh token with claims: ${errorData.error?.message || 'Unknown error'}`);
    }

    const refreshAuthData = await refreshAuthResponse.json();
    const finalIdToken = refreshAuthData.idToken; // This token has the custom claims

    // Generate refresh token (cryptographically secure random)
    const crypto = await import('crypto');
    const refreshToken = crypto.randomBytes(64).toString('base64url');

    // Hash refresh token for storage (prevent theft if DB compromised)
    const refreshTokenHash = crypto.createHash('sha256')
      .update(refreshToken)
      .digest('hex');

    // Store refresh token in Firestore
    // Note: expiresAt is intentionally omitted - tokens never expire for long-duration installations
    // Admins can manually revoke tokens via the admin panel if needed
    await adminDb.collection('agent_refresh_tokens').doc(refreshTokenHash).set({
      siteId,
      machineId,
      version,
      createdBy,
      createdAt: FieldValue.serverTimestamp(),
      lastUsed: FieldValue.serverTimestamp(),
      agentUid,
    });

    // Mark registration code as used
    await tokenRef.update({
      used: true,
      usedAt: FieldValue.serverTimestamp(),
      machineId,
      agentUid,
    });

    logger.info(`Agent token exchanged: site=${siteId}, machine=${machineId}, uid=${agentUid}`);

    return NextResponse.json(
      {
        accessToken: finalIdToken, // Use the refreshed token with custom claims
        refreshToken,
        expiresIn: 3600, // 1 hour in seconds
        siteId,
      },
      { status: 200 }
    );

  } catch (error: any) {
    console.error('Error exchanging registration code:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}, {
  strategy: 'tokenExchange',
  identifier: 'ip',
});
