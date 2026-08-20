/**
 * Live proof of possession of a second factor.
 *
 * WHAT THIS IS FOR
 *
 * A handful of routes must not settle for "the session cleared a challenge at
 * some point in the last seven days" — they need the caller to prove, in THIS
 * request, that they still hold a factor. `/api/mfa/disable` has always done
 * that inline ("No re-auth shortcut" in its header), and
 * `/api/mfa/backup-codes` must do the same: minting fresh recovery codes from
 * a warm session alone would hand a session thief a permanent, offline second
 * factor that also unlocks disable.
 *
 * Three proofs are accepted, and they are equivalent in strength:
 *
 *   - `totp`        — a current code from the enrolled authenticator.
 *   - `backup_code` — an unused recovery code, consumed on use.
 *   - `passkey`     — a UV-verified WebAuthn assertion against a credential
 *                     registered to this account (the same ceremony
 *                     `/api/passkeys/step-up/verify` runs, factored out here so
 *                     there is exactly one implementation of it).
 *
 * WHAT THIS MODULE DOES NOT DO
 *
 * - It never touches the session. Promoting a session to `mfaVerified` is the
 *   step-up route's job; a route that merely needs proof (regenerating backup
 *   codes) has no business re-minting the caller's cookie.
 * - It never writes factor state. `lib/mfaFactors.server.ts` owns that.
 * - It never audits. Callers emit the verb that describes the user-visible
 *   action, exactly as they do around `applyMfaFactorChange`.
 *
 * NOTE ON `/api/mfa/disable`: that route still carries its own copy of the
 * TOTP and backup-code blocks this module mirrors. It is deliberately untouched
 * by this wave (another task owns nothing in it, and it is the one route whose
 * failure mode is a hard account lockout); it should adopt `verifyMfaProof`
 * once this has soaked, which would also give it the passkey option for free.
 */

import { NextResponse } from 'next/server';
import {
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { verifyTOTP, verifyBackupCode } from '@/lib/totp';
import { decrypt, isEncryptionConfigured } from '@/lib/encryption.server';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  getRpId,
  getExpectedOrigins,
  getAndDeleteChallenge,
  getUserPasskeys,
  updatePasskeyCounter,
} from '@/lib/webauthn.server';

/** Which factor a caller actually presented — recorded in audit rows. */
export type MfaProofFactor = 'totp' | 'backup_code' | 'passkey';

/** The proof a request carried, after validation of its shape. */
export type MfaProof =
  | { kind: 'totp'; code: string }
  | { kind: 'backup_code'; code: string }
  | {
      kind: 'passkey';
      credential: AuthenticationResponseJSON;
      challengeId: string;
    };

/**
 * A refusal, in the repo's `{ error, code }` shape plus the status to send.
 * `error` is the human sentence clients surface directly; `code` is the
 * machine slug they branch on.
 */
export interface MfaProofRejection {
  ok: false;
  status: number;
  error: string;
  code: string;
}

export type MfaProofOutcome = { ok: true; factorUsed: MfaProofFactor } | MfaProofRejection;

export type MfaProofParse = { ok: true; proof: MfaProof } | MfaProofRejection;

function reject(status: number, error: string, code: string): MfaProofRejection {
  return { ok: false, status, error, code };
}

/** Turn a rejection into the response a route returns verbatim. */
export function mfaProofErrorResponse(rejection: MfaProofRejection): NextResponse {
  return NextResponse.json(
    { error: rejection.error, code: rejection.code },
    { status: rejection.status },
  );
}

/**
 * Read a proof out of a request body.
 *
 * Accepts the two body shapes already in the wild rather than inventing a
 * third: `{ code, isBackupCode }` (as `/api/mfa/disable` takes) and
 * `{ credential, challengeId }` (as the passkey step-up ceremony produces).
 * A body carrying neither is refused here, before the caller does anything —
 * "no proof" must never fall through to a success path.
 */
export function parseMfaProof(body: unknown): MfaProofParse {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  if (b.credential) {
    // A half-formed passkey proof is its own error rather than falling through
    // to "no proof supplied", which would send the caller looking for a code
    // they were never being asked for.
    if (typeof b.challengeId !== 'string' || !b.challengeId) {
      return reject(
        400,
        'a passkey proof must include the challengeId it was issued against.',
        'invalid_passkey_proof',
      );
    }
    return {
      ok: true,
      proof: {
        kind: 'passkey',
        credential: b.credential as AuthenticationResponseJSON,
        challengeId: b.challengeId,
      },
    };
  }

  if (typeof b.code === 'string' && b.code) {
    if (b.isBackupCode === true) {
      return { ok: true, proof: { kind: 'backup_code', code: b.code } };
    }
    if (b.code.length !== 6) {
      return reject(400, 'TOTP code must be 6 digits', 'invalid_totp_code');
    }
    return { ok: true, proof: { kind: 'totp', code: b.code } };
  }

  return reject(
    400,
    'a current 2FA code, a backup code, or a passkey is required for this action.',
    'mfa_proof_required',
  );
}

/** Verify a TOTP code against the account's stored (encrypted) secret. */
function verifyStoredTotp(
  code: string,
  userData: FirebaseFirestore.DocumentData,
): MfaProofOutcome {
  const encryptedSecret = userData.mfaSecret;
  if (!encryptedSecret || typeof encryptedSecret !== 'string') {
    return reject(400, 'this account has no authenticator enrolled.', 'totp_not_enrolled');
  }

  let secret: string;
  if (encryptedSecret.includes(':')) {
    if (!isEncryptionConfigured()) {
      console.error('[mfaProof] MFA_ENCRYPTION_KEY not configured');
      return reject(500, 'MFA encryption not configured', 'encryption_not_configured');
    }
    secret = decrypt(encryptedSecret);
  } else {
    // Legacy unencrypted format — same handling as verify-login and disable.
    secret = encryptedSecret;
  }

  if (!verifyTOTP(code, secret)) {
    return reject(400, 'invalid verification code', 'invalid_mfa_proof');
  }
  return { ok: true, factorUsed: 'totp' };
}

/**
 * Verify a backup code and consume it in the same transaction.
 *
 * Consumption is inside the transaction for the same reason it is in
 * `/api/mfa/disable`: a crash between "this code matched" and whatever the
 * caller does next must not leave the code replayable. Callers that go on to
 * replace the whole generation (regeneration) make this moot, but a caller
 * that fails midway leaves the account one code lighter rather than exposed.
 */
async function consumeBackupCode(
  userId: string,
  code: string,
): Promise<MfaProofOutcome> {
  const db = getAdminDb();
  const userRef = db.collection('users').doc(userId);
  const normalizedCode = code.toUpperCase().trim();

  const consumed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) {
      return { ok: false, reason: 'no_user' as const };
    }
    const data = snap.data() ?? {};
    const codes: string[] = Array.isArray(data.backupCodes) ? data.backupCodes : [];
    const idx = codes.findIndex((hash) => verifyBackupCode(normalizedCode, hash));
    if (idx === -1) {
      return { ok: false, reason: 'no_match' as const };
    }
    tx.update(userRef, { backupCodes: codes.filter((_, i) => i !== idx) });
    return { ok: true } as const;
  });

  if (!consumed.ok) {
    if (consumed.reason === 'no_user') {
      return reject(404, 'user not found', 'user_not_found');
    }
    return reject(400, 'invalid verification code', 'invalid_mfa_proof');
  }
  return { ok: true, factorUsed: 'backup_code' };
}

/**
 * Verify a WebAuthn step-up assertion against the SESSION'S OWN account.
 *
 * Extracted verbatim from `/api/passkeys/step-up/verify`, which now calls this.
 * The three checks that bind the ceremony to the account are all here, and
 * removing any one of them turns a step-up into a bypass:
 *   1. the stored challenge must have been minted for this uid (a `null` uid
 *      means it came from the pre-login discoverable-credential flow and must
 *      not be redeemable here),
 *   2. the asserted credential must be one of this uid's registered passkeys —
 *      we never look outside `users/{uid}/passkeys`, so another user's
 *      credential simply is not found, and
 *   3. `requireUserVerification: true`, so possession alone is not enough.
 *
 * `credential.response.userHandle` is IGNORED: it is attacker-controlled, and
 * the uid always comes from the caller's session instead.
 */
export async function verifyPasskeyStepUpAssertion(args: {
  userId: string;
  credential: AuthenticationResponseJSON;
  challengeId: string;
}): Promise<MfaProofOutcome> {
  const { userId, credential, challengeId } = args;

  // Single-use: getAndDeleteChallenge removes the record before returning, so
  // a replayed assertion cannot re-clear the gate.
  const challengeData = await getAndDeleteChallenge(challengeId);
  if (!challengeData) {
    return reject(
      400,
      'Challenge expired or not found. Please try again.',
      'challenge_not_found',
    );
  }

  if (challengeData.type !== 'authentication') {
    return reject(400, 'Invalid challenge type', 'invalid_challenge_type');
  }

  if (challengeData.userId !== userId) {
    return reject(403, 'Challenge does not belong to this user', 'challenge_user_mismatch');
  }

  const userPasskeys = await getUserPasskeys(userId);
  const matchingPasskey = userPasskeys.find((p) => p.credentialId === credential.id);

  if (!matchingPasskey) {
    return reject(400, 'Passkey not found for this user', 'passkey_not_found');
  }

  const verification = await verifyAuthenticationResponse({
    response: credential,
    expectedChallenge: challengeData.challenge,
    expectedOrigin: getExpectedOrigins(),
    expectedRPID: getRpId(),
    // Pinned explicitly even though @simplewebauthn/server already defaults it
    // to true — same reasoning as the sign-in route. Satisfying MFA with a
    // passkey rests entirely on the authenticator having verified the user
    // (PIN/biometric); without the `uv` flag this is possession only, and an
    // upstream default flip would silently turn step-up into a one-touch
    // bypass.
    requireUserVerification: true,
    credential: {
      id: matchingPasskey.credentialId,
      publicKey: isoBase64URL.toBuffer(matchingPasskey.credentialPublicKey),
      counter: matchingPasskey.counter,
      transports: matchingPasskey.transports,
    },
  });

  if (!verification.verified) {
    return reject(400, 'Authentication verification failed', 'assertion_failed');
  }

  // Update counter (clone detection).
  await updatePasskeyCounter(
    userId,
    matchingPasskey.credentialId,
    verification.authenticationInfo.newCounter,
  );

  return { ok: true, factorUsed: 'passkey' };
}

/**
 * Verify whichever proof the caller presented.
 *
 * `userData` is the user document the caller has already read (every caller
 * runs `assertActiveUser` first), so the TOTP branch costs no extra read.
 */
export async function verifyMfaProof(
  userId: string,
  proof: MfaProof,
  userData: FirebaseFirestore.DocumentData,
): Promise<MfaProofOutcome> {
  switch (proof.kind) {
    case 'totp':
      return verifyStoredTotp(proof.code, userData);
    case 'backup_code':
      return consumeBackupCode(userId, proof.code);
    case 'passkey':
      return verifyPasskeyStepUpAssertion({
        userId,
        credential: proof.credential,
        challengeId: proof.challengeId,
      });
  }
}
