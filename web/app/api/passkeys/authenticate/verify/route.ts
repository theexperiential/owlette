/**
 * Passkey Authentication Verification API
 *
 * Verifies the WebAuthn authentication response, creates a Firebase
 * custom token and iron-session. Passkey login skips 2FA entirely.
 *
 * POST /api/passkeys/authenticate/verify
 * Request: { credential: AuthenticationResponseJSON, challengeId: string }
 * Response: { success: boolean, customToken: string, userId: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { withRateLimit } from '@/lib/withRateLimit';
import { getAdminAuth } from '@/lib/firebase-admin';
import { createSession } from '@/lib/sessionManager.server';
import { apiError } from '@/lib/apiErrorResponse';
import {
  getRpId,
  getExpectedOrigins,
  getAndDeleteChallenge,
  getUserPasskeys,
  updatePasskeyCounter,
} from '@/lib/webauthn.server';

export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const body = await request.json();
    const { credential, challengeId } = body;

    if (!credential || !challengeId) {
      return NextResponse.json(
        { error: 'Missing credential or challengeId' },
        { status: 400 }
      );
    }

    // Retrieve and validate challenge
    const challengeData = await getAndDeleteChallenge(challengeId);
    if (!challengeData) {
      return NextResponse.json(
        { error: 'Challenge expired or not found. Please try again.' },
        { status: 400 }
      );
    }

    if (challengeData.type !== 'authentication') {
      return NextResponse.json({ error: 'Invalid challenge type' }, { status: 400 });
    }

    // Extract userHandle from credential response (set during registration)
    const userHandle = credential.response?.userHandle;
    if (!userHandle) {
      return NextResponse.json(
        { error: 'No user handle in credential response. Discoverable credential required.' },
        { status: 400 }
      );
    }

    // The userHandle is the userId we set during registration
    const userId = userHandle;

    // Find the matching credential
    const userPasskeys = await getUserPasskeys(userId);
    const credentialIdFromResponse = credential.id;

    const matchingPasskey = userPasskeys.find(
      (p) => p.credentialId === credentialIdFromResponse
    );

    if (!matchingPasskey) {
      return NextResponse.json(
        { error: 'Passkey not found for this user' },
        { status: 400 }
      );
    }

    // Verify authentication response
    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: challengeData.challenge,
      expectedOrigin: getExpectedOrigins(),
      expectedRPID: getRpId(),
      credential: {
        id: matchingPasskey.credentialId,
        publicKey: isoBase64URL.toBuffer(matchingPasskey.credentialPublicKey),
        counter: matchingPasskey.counter,
        transports: matchingPasskey.transports,
      },
    });

    if (!verification.verified) {
      return NextResponse.json(
        { error: 'Authentication verification failed' },
        { status: 400 }
      );
    }

    // Update counter (clone detection)
    const { authenticationInfo } = verification;
    await updatePasskeyCounter(
      userId,
      matchingPasskey.credentialId,
      authenticationInfo.newCounter
    );

    // Create iron-session
    await createSession(userId);

    // Create Firebase custom token for client-side Firebase Auth
    const adminAuth = getAdminAuth();
    const customToken = await adminAuth.createCustomToken(userId);

    return NextResponse.json({
      success: true,
      customToken,
      userId,
    });
  } catch (error) {
    return apiError(error, 'passkeys/authenticate/verify');
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});
