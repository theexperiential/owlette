import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, assertUserHasSiteAccess, requireSession } from '@/lib/apiAuth.server';
import { normalizePairPhrase } from '@/lib/pairPhrases';
import { apiError } from '@/lib/apiErrorResponse';
import {
  DEVICE_CODE_WRAP_VERSION,
  encryptDeviceCodeCredentials,
} from '@/lib/deviceCodeCrypto';
import logger from '@/lib/logger';

/**
 * POST /api/agent/auth/device-code/authorize
 *
 * User authorizes a device code from the web dashboard or /add page.
 * Generates Firebase tokens and stores them for the agent to poll.
 *
 * Request body:
 * - pairPhrase: string - The 3-word pairing phrase (e.g., "silver-compass-drift")
 * - siteId: string - The site to associate the agent with
 *
 * Response (200):
 * - success: true
 * - machineId: string | null
 *
 * Errors:
 * - 400: Missing fields, invalid phrase format
 * - 401: Not authenticated
 * - 403: No access to site
 * - 404: Phrase not found or expired
 * - 409: Already authorized
 */
export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const body = await request.json();
    const { pairPhrase: rawPhrase, siteId } = body;

    if (!rawPhrase || !siteId) {
      return NextResponse.json(
        { error: 'Missing required fields: pairPhrase, siteId' },
        { status: 400 }
      );
    }

    // Normalize and validate phrase format
    const pairPhrase = normalizePairPhrase(rawPhrase);
    if (!pairPhrase) {
      return NextResponse.json(
        { error: 'Invalid pairing phrase format' },
        { status: 400 }
      );
    }

    // Require authenticated user with access to the site
    const userId = await requireSession(request);
    await assertUserHasSiteAccess(userId, siteId);

    // Look up device code and authorize atomically using a transaction
    // to prevent race conditions where two concurrent requests both read
    // 'pending' and both authorize the same device code.
    const adminDb = getAdminDb();
    const docRef = adminDb.collection('device_codes').doc(pairPhrase);

    const result = await adminDb.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);

      if (!doc.exists) {
        return { error: 'Pairing phrase not found. It may have expired.', status: 404 } as const;
      }

      const data = doc.data()!;

      // Check expiry
      const expiresAt = data.expiresAt?.toMillis?.() || data.expiresAt?.getTime?.() || 0;
      if (Date.now() > expiresAt) {
        transaction.delete(docRef);
        return { error: 'Pairing phrase has expired. Please generate a new one on the target machine.', status: 404 } as const;
      }

      // Check status
      if (data.status !== 'pending') {
        return { error: 'This pairing phrase has already been used.', status: 409 } as const;
      }

      // Pre-authorized (dashboard "generate code") doc: the target hostname is
      // unknown here. Record ONLY the admin-authorized site; the agent token is
      // minted at poll time, bound to the real machineId the agent supplies.
      if (data.preauthorizedIntent === true) {
        transaction.update(docRef, {
          status: 'authorized',
          siteId,
          authorizedBy: userId,
          authorizedAt: FieldValue.serverTimestamp(),
          deferTokenMint: true,
        });
        return { success: true, machineId: null } as const;
      }

      const supportsEncryption =
        data.wrapVersion === DEVICE_CODE_WRAP_VERSION &&
        typeof data.deviceCode === 'string' &&
        data.deviceCode.length > 0;

      if (!supportsEncryption) {
        return { error: 'Invalid device code state for authorization.', status: 400 } as const;
      }

      const machineId = data.machineId;
      if (!machineId) {
        return { error: 'Invalid device code state for authorization.', status: 400 } as const;
      }

      // Generate unique agent user ID (same pattern as exchange endpoint)
      const agentUid = `agent_${siteId}_${machineId}`.replace(/[^a-zA-Z0-9_]/g, '_');

      // Generate Firebase Custom Token with agent claims
      const adminAuth = getAdminAuth();
      const customToken = await adminAuth.createCustomToken(agentUid, {
        role: 'agent',
        site_id: siteId,
        machine_id: machineId,
        version: data.version || 'unknown',
      });

      // Exchange custom token for ID token via Firebase Auth REST API
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

      // Set custom claims (must happen before the second token exchange)
      await adminAuth.setCustomUserClaims(agentUid, {
        role: 'agent',
        site_id: siteId,
        machine_id: machineId,
        version: data.version || 'unknown',
      });

      // Create a new custom token and exchange again to get ID token WITH claims
      const customTokenWithClaims = await adminAuth.createCustomToken(agentUid, {
        role: 'agent',
        site_id: siteId,
        machine_id: machineId,
        version: data.version || 'unknown',
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
      const finalIdToken = refreshAuthData.idToken;

      // Generate refresh token
      const crypto = await import('crypto');
      const refreshToken = crypto.randomBytes(64).toString('base64url');
      const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

      // Store refresh token in Firestore (same schema as exchange endpoint)
      // Note: writes to other documents within a transaction are atomic
      const refreshTokenRef = adminDb.collection('agent_refresh_tokens').doc(refreshTokenHash);
      transaction.set(refreshTokenRef, {
        siteId,
        machineId,
        version: data.version || 'unknown',
        createdBy: userId,
        createdAt: FieldValue.serverTimestamp(),
        lastUsed: FieldValue.serverTimestamp(),
        agentUid,
      });

      const credentialBundle = {
        accessToken: finalIdToken,
        refreshToken,
        expiresIn: 3600,
        siteId,
      };

      const encryptedCredentials = encryptDeviceCodeCredentials(
        credentialBundle,
        data.deviceCode,
        pairPhrase,
      );
      transaction.update(docRef, {
        status: 'authorized',
        siteId,
        authorizedBy: userId,
        authorizedAt: FieldValue.serverTimestamp(),
        encryptedCredentials,
        wrapVersion: DEVICE_CODE_WRAP_VERSION,
        // Wipe the deviceCode and any legacy plaintext fields so the
        // doc at rest cannot leak credentials or key material.
        deviceCode: FieldValue.delete(),
        accessToken: FieldValue.delete(),
        refreshToken: FieldValue.delete(),
      });

      logger.info(
        `Device code authorized: phrase=${pairPhrase}, site=${siteId}, machine=${machineId}, ` +
          `by=${userId}, wrap=${DEVICE_CODE_WRAP_VERSION}`,
      );

      return { success: true, machineId: data.machineId || null } as const;
    });

    if ('error' in result) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status }
      );
    }

    return NextResponse.json({
      success: true,
      machineId: result.machineId,
    });
  } catch (error: unknown) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'agent/auth/device-code/authorize');
  }
}, {
  strategy: 'tokenExchange',
  identifier: 'ip',
});
