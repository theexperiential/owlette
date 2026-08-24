/**
 * POST /api/passkeys/authenticate/options — WebAuthn options for passkey login.
 * Unauthenticated by nature (pre-login). Discoverable credentials, so no email is typed.
 * in: {}   out: { options: PublicKeyCredentialRequestOptionsJSON, challengeId }
 */

import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { getRpId, storeChallenge } from '@/lib/webauthn.server';
import { apiError } from '@/lib/apiErrorResponse';

export const POST = withRateLimit(async () => {
  try {
    const options = await generateAuthenticationOptions({
      rpID: getRpId(),
      // PIN/biometric required: a single-touch FIDO key is not enough for full account access.
      userVerification: 'required',
    });

    // Random id — no user is known yet.
    const challengeId = randomBytes(32).toString('hex');

    await storeChallenge(challengeId, options.challenge, null, 'authentication');

    return NextResponse.json({ options, challengeId });
  } catch (error) {
    return apiError(error, 'passkeys/authenticate/options');
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});
