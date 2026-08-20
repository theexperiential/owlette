/**
 * Passkey Registration Verification API
 *
 * Verifies the WebAuthn registration response and stores the credential.
 *
 * POST /api/passkeys/register/verify
 * Request: { userId: string, credential: RegistrationResponseJSON, friendlyName?: string }
 * Response: { success: boolean, credentialId: string }
 *
 * SECURITY — the enrollment gate:
 *   `/api/*` is deliberately NOT MFA-gated (`proxy.ts` returns early for every
 *   `/api` path, and `requireSessionUser` only checks uid equality). Now that a
 *   UV-verified passkey satisfies MFA in a single ceremony, a session that has
 *   not cleared a challenge but CAN enroll a new factor can step straight up
 *   into a verified session — a full MFA bypass from a stolen `__session`
 *   cookie, plus a permanent attacker-controlled credential on the account.
 *   So: enrolling the FIRST factor stays open (that is the mandatory-setup
 *   path), and every enrollment after that requires `mfaVerified`. The gate is
 *   re-checked here rather than trusted from register/options, because nothing
 *   stops a caller from posting a credential straight at this route.
 *
 * The inventory (`users/{uid}.mfaFactors`, `mfaEnrolled`, `requiresMfaSetup`)
 * is updated exclusively through `applyMfaFactorChange` — see
 * `lib/mfaFactors.server.ts`; this route must never write those fields itself.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, assertActiveUser, requireSessionUser } from '@/lib/apiAuth.server';
import { apiError } from '@/lib/apiErrorResponse';
import { emitMutation } from '@/lib/auditLogClient';
import {
  applyMfaFactorChange,
  deriveMfaEnrolled,
} from '@/lib/mfaFactors.server';
import { checkMfaEnrollmentGate } from '@/lib/mfaEnrollmentGate.server';
import { markSessionMfaVerified } from '@/lib/sessionManager.server';
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
    await assertActiveUser(userId);

    // THE ENROLLMENT GATE — the same shared implementation the TOTP routes use;
    // see `lib/mfaEnrollmentGate.server.ts`. Re-checked here rather than trusted
    // from register/options, because a caller can POST a credential straight at
    // this route. The gate hands back the inventory it read, and `factorsBefore`
    // then serves a second purpose: compared against the post-write result below
    // it tells us whether this passkey is the account's FIRST factor.
    const gate = await checkMfaEnrollmentGate(userId);
    if (gate.denied) return gate.denied;
    const factorsBefore = gate.factors;

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
      // Pinned rather than defaulted, matching the login verify site: a passkey
      // only counts as a second factor because the authenticator verified the
      // user (PIN/biometric). A credential enrolled without UV would satisfy
      // `mfaEnrolled` while failing every UV-required login.
      requireUserVerification: true,
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

    // Refresh the denormalized factor inventory. `recountPasskeys` — never an
    // explicit count — is the only value that cannot drift: it is read from the
    // subcollection inside the same transaction that writes the tally.
    const factorsAfter = await applyMfaFactorChange(userId, {
      recountPasskeys: true,
    });

    // FIRST factor on the account: promote the session to MFA-verified, exactly
    // as /api/mfa/verify-setup does after TOTP enrollment. The user just proved
    // possession of the credential in a UV ceremony, and the write above flipped
    // `mfaEnrolled` to true — so without this the very next AuthContext
    // session-create would bounce them to /verify-2fa with nothing to present.
    // That is a self-inflicted lockout for precisely the passkey-only signup
    // this feature exists to serve.
    const wasFirstFactor =
      !deriveMfaEnrolled(factorsBefore) && factorsAfter.mfaEnrolled;
    if (wasFirstFactor) {
      await markSessionMfaVerified();
    }

    // Audit. Registering a credential is the cheapest persistent-access move an
    // attacker with a live session has, so it gets its own row. Platform-tenant
    // mutation (siteId = '') like the other account-security events.
    emitMutation({
      kind: 'user_mutated',
      siteId: '',
      actor: `user:${userId}`,
      targetId: userId,
      attributes: {
        endpoint: '/api/passkeys/register/verify',
        method: 'POST',
        verb: 'passkey_added',
        credentialId,
        deviceType: registrationInfo.credentialDeviceType,
        backedUp: registrationInfo.credentialBackedUp,
        passkeyCount: factorsAfter.factors.passkeys,
        firstFactor: wasFirstFactor,
      },
    });

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
