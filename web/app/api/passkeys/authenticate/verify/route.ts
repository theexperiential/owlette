/**
 * Passkey Authentication Verification API
 *
 * Verifies the WebAuthn authentication response, then creates the session via
 * `createSession` and mints a Firebase custom token. Passkey login SATISFIES 2FA
 * in a single ceremony: the verification below pins `requireUserVerification:
 * true`, so a successful verify proves possession of the credential and
 * verification of the user (PIN/biometric) together. The session is therefore
 * created with `mfaSatisfiedBy: 'passkey-uv'` and is born `mfaVerified` even for
 * a TOTP-enrolled user, instead of bouncing them to `/verify-2fa`.
 *
 * `mfaRequired` is still re-derived from Firestore by `createSession` — this
 * route asserts only that the challenge has been SATISFIED, never that it does
 * not apply.
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
import { ApiAuthError, assertActiveUser } from '@/lib/apiAuth.server';
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

    // The userHandle carries the uid we set as `userID` at registration — but it
    // arrives BASE64URL-ENCODED, not raw. `register/options` passes
    // `isoUint8Array.fromUTF8String(userId)`, and @simplewebauthn/browser
    // base64url-encodes every ArrayBuffer on the way back out
    // (`startAuthentication.js`: `userHandle = bufferToBase64URLString(...)`;
    // the JSON type is `userHandle?: Base64URLString`). Using it verbatim looked
    // up `users/<base64url-of-uid>`, which never exists, so every passkey
    // sign-in died in `assertActiveUser` with a 403 "User is deleted or
    // inactive" — a misleading error for what was really a decode bug.
    //
    // This was silently broken from the start: the only passkey e2e spec
    // deliberately stopped short of a real ceremony, so no test ever reached
    // this line until `e2e/specs/mfa/passkey-factor.spec.ts` did.
    const userId = isoBase64URL.toUTF8String(userHandle);
    await assertActiveUser(userId);

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
      // Pinned explicitly even though @simplewebauthn/server already defaults it
      // to true. Treating a passkey as a second factor rests entirely on the
      // authenticator having verified the user (PIN/biometric) — without the
      // `uv` flag this is possession only, and a future upstream default flip
      // would silently downgrade every passkey login to single-factor.
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
    const { authenticationInfo } = verification;
    await updatePasskeyCounter(
      userId,
      matchingPasskey.credentialId,
      authenticationInfo.newCounter
    );

    // Create iron-session. Reaching this line means `verifyAuthenticationResponse`
    // returned verified WITH `requireUserVerification: true` (pinned above), so the
    // authenticator checked the human and not just the credential — the whole basis
    // for treating one passkey ceremony as two factors. The `'passkey-uv'` literal
    // is hardcoded here on purpose: the argument is server-side only and must never
    // be derived from the request (see the parameter docs on `createSession`).
    await createSession(userId, 7, 'passkey-uv');

    // Create Firebase custom token for client-side Firebase Auth
    const adminAuth = getAdminAuth();
    const customToken = await adminAuth.createCustomToken(userId);

    return NextResponse.json({
      success: true,
      customToken,
      userId,
    });
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'passkeys/authenticate/verify');
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});
