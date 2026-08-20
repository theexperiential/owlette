/**
 * Passkey Step-Up Verification API
 *
 * Verifies a WebAuthn assertion produced by `/api/passkeys/step-up/options` and,
 * on success, marks the CALLER'S EXISTING session as having cleared the MFA
 * challenge. Nothing else happens: no session is created, no Firebase custom
 * token is minted, no factor state is written. Contrast
 * `/api/passkeys/authenticate/verify`, which is a pre-login endpoint and does
 * both of those things for an unauthenticated caller — reusing it here would
 * hand a fresh credential to anyone who reached this route.
 *
 * The uid is taken from the session and from nowhere else. In particular
 * `credential.response.userHandle` is IGNORED: it is attacker-controlled, and
 * the sign-in route only trusts it because it has no session to trust instead.
 *
 * Three independent checks bind the ceremony to the session's own account:
 *   1. the stored challenge must have been minted for this uid,
 *   2. the asserted credential id must be one of this uid's registered
 *      passkeys (a credential belonging to another user simply will not be
 *      found — we never look outside `users/{uid}/passkeys`), and
 *   3. `requireUserVerification: true`, so possession alone is not enough.
 *
 * DEPENDENCY — do not remove silently: task 2.3 gates passkey REGISTRATION
 * behind an already-satisfied MFA challenge. That gate is what prevents an
 * attacker who holds only a `__session` cookie from registering a fresh
 * attacker-controlled credential and immediately stepping up with it. If
 * registration is ever reopened to an unverified session, this route becomes a
 * full MFA bypass.
 *
 * POST /api/passkeys/step-up/verify
 * Request: { credential: AuthenticationResponseJSON, challengeId: string }
 * Response: { success: true }
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { withRateLimit } from '@/lib/withRateLimit';
import { apiError } from '@/lib/apiErrorResponse';
import { ApiAuthError, assertActiveUser, requireSession } from '@/lib/apiAuth.server';
import { markSessionMfaVerified } from '@/lib/sessionManager.server';
import {
  getRpId,
  getExpectedOrigins,
  getAndDeleteChallenge,
  getUserPasskeys,
  updatePasskeyCounter,
} from '@/lib/webauthn.server';

export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const userId = await requireSession(request);
    await assertActiveUser(userId);

    const body = await request.json();
    const { credential, challengeId } = body;

    if (!credential || typeof challengeId !== 'string' || !challengeId) {
      return NextResponse.json(
        { error: 'Missing credential or challengeId' },
        { status: 400 }
      );
    }

    // Single-use: getAndDeleteChallenge removes the record before returning, so
    // a replayed assertion cannot re-clear the gate.
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

    // Bind the challenge to the session. Step-up challenges are always stored
    // with a uid; a null userId means this id came from the pre-login
    // discoverable-credential flow, which must not be redeemable here.
    if (challengeData.userId !== userId) {
      return NextResponse.json({ error: 'Challenge does not belong to this user' }, {
        status: 403,
      });
    }

    // Only this user's own credentials are ever considered — this is what makes
    // another user's passkey unusable here, not a comparison we could forget.
    const userPasskeys = await getUserPasskeys(userId);
    const matchingPasskey = userPasskeys.find((p) => p.credentialId === credential.id);

    if (!matchingPasskey) {
      return NextResponse.json(
        { error: 'Passkey not found for this user' },
        { status: 400 }
      );
    }

    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: challengeData.challenge,
      expectedOrigin: getExpectedOrigins(),
      expectedRPID: getRpId(),
      // Pinned explicitly even though @simplewebauthn/server already defaults it
      // to true — same reasoning as the sign-in route. Satisfying the MFA gate
      // with a passkey rests entirely on the authenticator having verified the
      // user (PIN/biometric); without the `uv` flag this is possession only,
      // and an upstream default flip would silently turn step-up into a
      // one-touch bypass.
      requireUserVerification: true,
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
    await updatePasskeyCounter(
      userId,
      matchingPasskey.credentialId,
      verification.authenticationInfo.newCounter
    );

    // Flip the existing session's MFA gate. This is the ONLY state this route
    // writes to the session — it never calls createSession (which would re-mint
    // expiry and re-read factor state) and never mints a custom token.
    await markSessionMfaVerified();

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'passkeys/step-up/verify');
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});
