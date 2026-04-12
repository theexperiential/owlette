/**
 * Passkey Authentication Options API
 *
 * Generates WebAuthn authentication options for passkey login.
 * No authentication required — this is a pre-login endpoint.
 * Uses discoverable credentials so users don't need to type their email.
 *
 * POST /api/passkeys/authenticate/options
 * Request: {} (empty)
 * Response: { options: PublicKeyCredentialRequestOptionsJSON, challengeId: string }
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
      userVerification: 'preferred',
    });

    // Generate random challenge ID (no user known yet)
    const challengeId = randomBytes(32).toString('hex');

    // Store challenge for verification
    await storeChallenge(challengeId, options.challenge, null, 'authentication');

    return NextResponse.json({ options, challengeId });
  } catch (error) {
    return apiError(error, 'passkeys/authenticate/options');
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});
