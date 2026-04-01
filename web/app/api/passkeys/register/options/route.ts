/**
 * Passkey Registration Options API
 *
 * Generates WebAuthn registration options for a logged-in user.
 * The challenge is stored server-side with a 10-minute expiry.
 *
 * POST /api/passkeys/register/options
 * Request: { userId: string }
 * Response: PublicKeyCredentialCreationOptionsJSON
 */

import { NextRequest, NextResponse } from 'next/server';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import { isoUint8Array } from '@simplewebauthn/server/helpers';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, requireSessionUser } from '@/lib/apiAuth.server';
import {
  getRpId,
  getRpName,
  getUserPasskeys,
  storeChallenge,
} from '@/lib/webauthn.server';

export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const body = await request.json();
    const { userId } = body;

    if (!userId || typeof userId !== 'string') {
      return NextResponse.json({ error: 'Invalid user ID' }, { status: 400 });
    }

    await requireSessionUser(request, userId);

    // Get existing passkeys to exclude (prevent re-registration)
    const existingPasskeys = await getUserPasskeys(userId);
    const excludeCredentials = existingPasskeys.map((p) => ({
      id: p.credentialId,
      transports: p.transports,
    }));

    const options = await generateRegistrationOptions({
      rpName: getRpName(),
      rpID: getRpId(),
      userName: userId,
      userID: isoUint8Array.fromUTF8String(userId),
      attestationType: 'none',
      excludeCredentials,
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    // Store challenge for verification
    await storeChallenge(userId, options.challenge, userId, 'registration');

    return NextResponse.json(options);
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[Passkey Register Options] Error:', error);
    return NextResponse.json(
      { error: 'Failed to generate registration options' },
      { status: 500 }
    );
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});
