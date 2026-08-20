/**
 * Backup Codes API
 *
 * Mints a fresh generation of recovery codes for the caller's own account and
 * returns the plaintext EXACTLY ONCE. Only the hashes are stored, so there is
 * no second chance to read them — regeneration is the only recovery from a
 * lost sheet, and it invalidates every previously issued code.
 *
 * POST /api/mfa/backup-codes
 * Request (one proof, three accepted shapes):
 *   { code: "123456" }                          — a current TOTP code
 *   { code: "A1B2C3D4", isBackupCode: true }    — an unused backup code
 *   { credential, challengeId }                 — a passkey step-up assertion
 *     (obtained from /api/passkeys/step-up/options, same ceremony as
 *      /api/passkeys/step-up/verify)
 * Response (200): { success: true, backupCodes: string[], count: number }
 *
 * WHY THIS EXISTS
 *
 * Backup codes used to be a side effect of TOTP enrollment: generated in the
 * browser by `setup-2fa`, persisted only by `/api/mfa/verify-setup`. Under
 * universal 2FA a passkey-only account is fully MFA-enrolled and never touches
 * that path, so it had no recovery material at all — lose the authenticator
 * device and the only way back in is manual support. This route is how any
 * enrolled account gets (or replaces) its codes, independent of TOTP.
 *
 * SECURITY — why a warm session is not enough
 *
 *   ACTOR      someone holding the victim's `__session` cookie (7-day life,
 *              and `/api/*` is not MFA-gated by the proxy).
 *   MECHANISM  POST here with no proof, pocket the ten codes.
 *   OUTCOME    a permanent, offline second factor on the victim's account —
 *              one that also satisfies `/api/mfa/disable`, whose whole design
 *              premise is that it demands live proof every single time ("No
 *              re-auth shortcut" in its header). Gating this route on nothing
 *              but `session.mfaVerified` would therefore be strictly weaker
 *              than the gate on the route its output defeats.
 *
 * So the caller must prove possession of a factor IN THIS REQUEST, via
 * `verifyMfaProof`. A TOTP code, a backup code and a UV-verified passkey
 * assertion are accepted interchangeably: a passkey-only account must be able
 * to mint its first sheet, and requiring TOTP here would lock exactly the users
 * this feature exists for out of recovery entirely.
 *
 * THE ONE EXCEPTION — first enrollment.
 *
 * A brand-new account cannot present a proof it does not yet have. That case
 * is `/api/mfa/verify-setup`, which has just verified a TOTP code for the
 * factor it is enrolling in the very same request, and which mints its sheet by
 * calling `issueBackupCodes()` in-process. The boundary is the module call, not
 * a flag: this HTTP route has NO bypass parameter, no internal-secret header
 * and no "skip proof" branch, so the exception can never be reached from the
 * network. Adding one would reopen the attack above.
 */

import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, assertActiveUser, requireSession } from '@/lib/apiAuth.server';
import { apiError } from '@/lib/apiErrorResponse';
import { issueBackupCodes, BACKUP_CODE_COUNT } from '@/lib/backupCodes.server';
import {
  mfaProofErrorResponse,
  parseMfaProof,
  verifyMfaProof,
} from '@/lib/mfaProof.server';
import { emitMutation } from '@/lib/auditLogClient';

export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    // The session is authoritative for which account we operate on — there is
    // no `userId` parameter, so this route can never be pointed at another
    // user's document.
    const userId = await requireSession(request);
    const userData = await assertActiveUser(userId);

    const body = await request.json().catch(() => ({}));

    // Shape first, so a malformed body is refused before any Firestore work.
    const parsed = parseMfaProof(body);
    if (!parsed.ok) {
      return mfaProofErrorResponse(parsed);
    }

    // Then the proof itself. Nothing below this line runs for a caller who
    // could not demonstrate a factor in this request.
    const proof = await verifyMfaProof(userId, parsed.proof, userData);
    if (!proof.ok) {
      return mfaProofErrorResponse(proof);
    }

    // Mint the new generation. `issueBackupCodes` hashes as it generates, so
    // the plaintext half never reaches a write payload.
    const { plaintext, hashed } = issueBackupCodes(BACKUP_CODE_COUNT);

    // Wholesale replacement, not a merge into the existing array: issuing a new
    // sheet must retire the old one. If a backup code was the proof presented
    // above it has already been consumed from the array this overwrites, so
    // there is no ordering hazard either way.
    //
    // This write deliberately does NOT touch `mfaEnrolled` / `requiresMfaSetup`
    // (owned exclusively by `lib/mfaFactors.server.ts`) — backup codes are
    // recovery material for an existing factor, not a factor of their own, so
    // the inventory is unchanged by definition.
    await getAdminDb().collection('users').doc(userId).update({
      backupCodes: hashed,
      backupCodesGeneratedAt: FieldValue.serverTimestamp(),
    });

    // Audit. Platform-tenant mutation (siteId = '') so the cloud function
    // records it on the platform partition, mirroring `mfa_enrolled` /
    // `mfa_disabled`. The count is recorded; the codes obviously are not.
    emitMutation({
      kind: 'user_mutated',
      siteId: '',
      actor: `user:${userId}`,
      targetId: userId,
      attributes: {
        endpoint: '/api/mfa/backup-codes',
        method: 'POST',
        verb: 'mfa_backup_codes_regenerated',
        factor: 'backup_codes',
        // Which factor the caller proved to get here — a passkey-only account
        // regenerating its sheet is the case this whole route exists for.
        factorUsed: proof.factorUsed,
        backupCodesIssued: hashed.length,
      },
    });

    return NextResponse.json({
      success: true,
      backupCodes: plaintext,
      count: plaintext.length,
    });
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'mfa/backup-codes');
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});
