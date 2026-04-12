/**
 * Passkey Registration Verification API
 *
 * Verifies the WebAuthn registration response and stores the credential.
 *
 * POST /api/passkeys/register/verify
 * Request: { userId: string, credential: RegistrationResponseJSON, friendlyName?: string }
 * Response: { success: boolean, credentialId: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, requireSessionUser } from '@/lib/apiAuth.server';
import { apiError } from '@/lib/apiErrorResponse';
import {
  getRpId,
  getExpectedOrigins,
  getAndDeleteChallenge,
  storePasskey,
} from '@/lib/webauthn.server';

export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const body = await request.json();
    const { userId, credential, friendlyName } = body;

    if (!userId || typeof userId !== 'string') {
      return NextResponse.json({ error: 'Invalid user ID' }, { status: 400 });
    }

    if (!credential) {
      return NextResponse.json({ error: 'Missing credential' }, { status: 400 });
    }

    await requireSessionUser(request, userId);

    // Retrieve and validate challenge
    const challengeData = await getAndDeleteChallenge(userId);
    if (!challengeData) {
      return NextResponse.json(
        { error: 'Challenge expired or not found. Please try again.' },
        { status: 400 }
      );
    }

    if (challengeData.type !== 'registration' || challengeData.userId !== userId) {
      return NextResponse.json({ error: 'Invalid challenge' }, { status: 400 });
    }

    // Verify registration response
    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: challengeData.challenge,
      expectedOrigin: getExpectedOrigins(),
      expectedRPID: getRpId(),
    });

    if (!verification.verified || !verification.registrationInfo) {
      return NextResponse.json(
        { error: 'Registration verification failed' },
        { status: 400 }
      );
    }

    const { registrationInfo } = verification;
    const credentialId = registrationInfo.credential.id; // Already Base64URLString
    const credentialPublicKey = isoBase64URL.fromBuffer(
      registrationInfo.credential.publicKey // Uint8Array -> Base64URLString
    );

    // Store credential in Firestore
    await storePasskey(
      userId,
      {
        credentialId,
        credentialPublicKey,
        counter: registrationInfo.credential.counter,
        transports: registrationInfo.credential.transports,
        deviceType: registrationInfo.credentialDeviceType,
        backedUp: registrationInfo.credentialBackedUp,
      },
      friendlyName || 'Passkey'
    );

    return NextResponse.json({ success: true, credentialId });
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'passkeys/register/verify');
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});
