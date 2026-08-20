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
 * The ceremony itself lives in `lib/mfaProof.server.ts`
 * (`verifyPasskeyStepUpAssertion`) because a passkey assertion is one of the
 * three interchangeable proofs of possession — `/api/mfa/backup-codes` accepts
 * the same one. This route contributes the session promotion on top of it, and
 * nothing else. The uid handed to the ceremony comes from the session and from
 * nowhere else; in particular `credential.response.userHandle` is IGNORED,
 * because it is attacker-controlled and the sign-in route only trusts it
 * because it has no session to trust instead.
 *
 * Three independent checks inside that ceremony bind the assertion to the
 * session's own account:
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
import { withRateLimit } from '@/lib/withRateLimit';
import { apiError } from '@/lib/apiErrorResponse';
import { ApiAuthError, assertActiveUser, requireSession } from '@/lib/apiAuth.server';
import { markSessionMfaVerified } from '@/lib/sessionManager.server';
import {
  mfaProofErrorResponse,
  verifyPasskeyStepUpAssertion,
} from '@/lib/mfaProof.server';

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

    const proof = await verifyPasskeyStepUpAssertion({
      userId,
      credential,
      challengeId,
    });
    if (!proof.ok) {
      return mfaProofErrorResponse(proof);
    }

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
