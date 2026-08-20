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
import { ApiAuthError, assertActiveUser, requireSessionUser } from '@/lib/apiAuth.server';
import { apiError } from '@/lib/apiErrorResponse';
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

    // The account labels baked into the credential come from the user document,
    // never from the request body: the body is attacker-controlled, and whatever
    // we pass here is what the authenticator shows the user at every future
    // login. `assertActiveUser` returns that document and rejects soft-deleted
    // accounts, matching the sibling register/verify route.
    const userData = await assertActiveUser(userId);
    const email = typeof userData.email === 'string' ? userData.email.trim() : '';
    const displayName =
      typeof userData.displayName === 'string' ? userData.displayName.trim() : '';

    // `userName` is what 1Password and the OS credential picker print under the
    // site name, so it must be human-readable — the raw uid used to land there
    // as meaningless hex. The uid stays as `userID`, which is the actual handle
    // the authenticator returns to us on login. Fall back to the uid only if a
    // user document somehow carries no email; a blank label is worse than hex.
    const userName = email || userId;
    const userDisplayName = displayName || email || userId;

    // Get existing passkeys to exclude (prevent re-registration)
    const existingPasskeys = await getUserPasskeys(userId);
    const excludeCredentials = existingPasskeys.map((p) => ({
      id: p.credentialId,
      transports: p.transports,
    }));

    const options = await generateRegistrationOptions({
      rpName: getRpName(),
      rpID: getRpId(),
      userName,
      userDisplayName,
      userID: isoUint8Array.fromUTF8String(userId),
      attestationType: 'none',
      excludeCredentials,
      authenticatorSelection: {
        residentKey: 'preferred',
        // Require user verification (PIN/biometric) — single-touch FIDO keys aren't sufficient for full account access.
        userVerification: 'required',
      },
    });

    // Store challenge for verification
    await storeChallenge(userId, options.challenge, userId, 'registration');

    return NextResponse.json(options);
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'passkeys/register/options');
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});
