/**
 * Passkey Step-Up Options API
 *
 * Generates WebAuthn authentication options for a caller who is ALREADY signed
 * in and is sitting on the `/verify-2fa` challenge. This is deliberately a
 * separate endpoint from `/api/passkeys/authenticate/options`: that one is a
 * pre-login endpoint that takes no session, uses discoverable credentials, and
 * whose verify sibling mints a session plus a Firebase custom token. Step-up
 * must do none of that — it only proves a second factor for the session that
 * already exists.
 *
 * The two concrete differences from the sign-in route:
 *   1. A session is REQUIRED, and the ceremony is scoped to that session's own
 *      uid — never a uid taken from the request body.
 *   2. `allowCredentials` is pinned to that user's registered credentials, so
 *      the browser will not offer (and the verify sibling will not accept) a
 *      credential belonging to somebody else.
 *
 * DEPENDENCY — do not remove silently: task 2.3 gates passkey REGISTRATION
 * behind an already-satisfied MFA challenge (zero factors enrolled → open;
 * one or more → session `mfaVerified` required, else 403
 * `mfa_challenge_required`). That gate is what stops an attacker holding only a
 * `__session` cookie from registering a fresh attacker-controlled credential
 * and immediately stepping up with it. Step-up is only ever as strong as that
 * registration gate.
 *
 * POST /api/passkeys/step-up/options
 * Request: {} (empty — the uid comes from the session, never the body)
 * Response: { options: PublicKeyCredentialRequestOptionsJSON, challengeId: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, assertActiveUser, requireSession } from '@/lib/apiAuth.server';
import { apiError } from '@/lib/apiErrorResponse';
import { getRpId, getUserPasskeys, storeChallenge } from '@/lib/webauthn.server';

export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const userId = await requireSession(request);
    await assertActiveUser(userId);

    const passkeys = await getUserPasskeys(userId);
    if (passkeys.length === 0) {
      // Nothing to challenge against. Reported with a machine-readable code so
      // the challenge page can tell "this account owns no passkeys" apart from
      // a genuine failure and keep pointing the user at the TOTP / backup-code
      // paths instead of showing a scary error.
      return NextResponse.json(
        { error: 'No passkeys registered for this user', code: 'no_passkeys' },
        { status: 400 }
      );
    }

    const options = await generateAuthenticationOptions({
      rpID: getRpId(),
      // Scoped to this user's own credentials. A step-up must prove THIS
      // account's second factor, so the discoverable-credential prompt used at
      // sign-in — which may return any passkey on the device — is wrong here.
      allowCredentials: passkeys.map((p) => ({
        id: p.credentialId,
        transports: p.transports,
      })),
      // Require user verification (PIN/biometric). A passkey only counts as a
      // second factor when the authenticator actually verified the human;
      // without `uv` this is possession alone. The verify sibling pins
      // `requireUserVerification: true` to enforce it on the response.
      userVerification: 'required',
    });

    // Random challenge id, stored against this uid. The verify sibling refuses
    // any challenge whose stored userId is not the session's uid, so a
    // challenge minted for one account can never be redeemed by another.
    const challengeId = randomBytes(32).toString('hex');
    await storeChallenge(challengeId, options.challenge, userId, 'authentication');

    return NextResponse.json({ options, challengeId });
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'passkeys/step-up/options');
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});
