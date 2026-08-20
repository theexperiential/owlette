/**
 * MFA Verify Setup API
 *
 * Verifies TOTP code during setup, then encrypts and stores the secret
 *
 * POST /api/mfa/verify-setup
 * Request: { userId: string, code: string, backupCodes?: string[] }
 *   - `backupCodes` is optional and deprecated: omit it and the server mints
 *     the sheet itself. The parameter survives only for today's browser-side
 *     generation in `app/setup-2fa/page.tsx` (wave 4 removes both).
 * Response: { success: boolean, backupCodes: string[] }
 *   - the plaintext sheet, returned exactly once; only hashes are stored.
 *
 * SECURITY:
 * - Verifies the TOTP code is correct before enabling MFA
 * - Encrypts the secret using server-side key before storing
 * - Clears pending setup data after successful verification
 * - Adding a factor to an account that already holds one requires an
 *   MFA-verified session (see `lib/mfaEnrollmentGate.server.ts`)
 * - Never overwrites an existing TOTP secret — that path is disable-then-enroll
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyTOTP, hashBackupCode } from '@/lib/totp';
import { issueBackupCodes, type IssuedBackupCodes } from '@/lib/backupCodes.server';
import { encrypt, isEncryptionConfigured } from '@/lib/encryption.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, assertActiveUser, requireSessionUser } from '@/lib/apiAuth.server';
import { apiError } from '@/lib/apiErrorResponse';
import { markSessionMfaVerified } from '@/lib/sessionManager.server';
import { applyMfaFactorChange } from '@/lib/mfaFactors.server';
import { emitMutation } from '@/lib/auditLogClient';
import { checkMfaEnrollmentGate } from '@/lib/mfaEnrollmentGate.server';

export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const body = await request.json();
    const { userId, code, backupCodes } = body;

    // Validate inputs
    if (!userId || typeof userId !== 'string') {
      return NextResponse.json(
        { error: 'Invalid user ID' },
        { status: 400 }
      );
    }

    if (!code || typeof code !== 'string' || code.length !== 6) {
      return NextResponse.json(
        { error: 'Invalid verification code' },
        { status: 400 }
      );
    }

    // `backupCodes` is optional as of the universal-2FA wave. When the client
    // omits it we mint the sheet here (see below); when it sends one we still
    // honour it, because `app/setup-2fa/page.tsx` generates the codes in the
    // browser and is already showing them to the user by the time this request
    // lands — silently storing a different set would leave them holding ten
    // strings that unlock nothing. A malformed value is still a 400: an empty
    // array is a client bug, not a request to generate.
    if (
      backupCodes !== undefined &&
      (!Array.isArray(backupCodes) ||
        backupCodes.length === 0 ||
        !backupCodes.every((c) => typeof c === 'string' && c.length > 0))
    ) {
      return NextResponse.json(
        { error: 'Backup codes are required' },
        { status: 400 }
      );
    }

    await requireSessionUser(request, userId);
    await assertActiveUser(userId);

    // Check encryption is configured
    if (!isEncryptionConfigured()) {
      console.error('[MFA Verify Setup] MFA_ENCRYPTION_KEY not configured');
      return NextResponse.json(
        { error: 'MFA encryption not configured' },
        { status: 500 }
      );
    }

    const db = getAdminDb();

    // SECURITY, part 1 — the enrollment gate.
    //
    // This route used to refuse outright whenever `mfaEnrolled === true`,
    // which stopped an attacker holding a captured session (primary auth
    // passed, MFA NOT — `/api/*` is not gated by the proxy MFA check) from
    // minting a pending secret via /api/mfa/setup and overwriting the
    // victim's mfaSecret+backupCodes with their own.
    //
    // Universal 2FA cannot keep that blanket refusal: `mfaEnrolled` is now
    // true for a passkey-only account, and such a user must still be able to
    // ADD TOTP. So the blanket check narrows to the per-factor one below, and
    // the stolen-session attack is stopped instead by the enrollment gate —
    // any account that already holds a factor must present an MFA-verified
    // session to add another. Narrowing one without the other would reopen
    // the bypass for every passkey-only account.
    const gate = await checkMfaEnrollmentGate(userId);
    if (gate.denied) {
      return gate.denied;
    }

    // SECURITY, part 2 — never overwrite a live TOTP secret. Even an
    // MFA-verified session must go through /api/mfa/disable (which demands
    // proof of possession of the CURRENT factor) before re-enrolling TOTP,
    // so a hijacked-but-verified session cannot silently swap the secret out
    // from under the account's owner.
    if (gate.factors.totp) {
      return NextResponse.json(
        {
          error:
            'TOTP is already enrolled. Disable it via /api/mfa/disable (which requires proof of your current factor) before re-enrolling.',
          code: 'mfa_already_enrolled',
        },
        { status: 409 },
      );
    }

    // Get pending setup
    const pendingDoc = await db.collection('mfa_pending').doc(userId).get();
    if (!pendingDoc.exists) {
      return NextResponse.json(
        { error: 'No pending MFA setup found. Please start setup again.' },
        { status: 400 }
      );
    }

    const pendingData = pendingDoc.data();
    if (!pendingData) {
      return NextResponse.json(
        { error: 'Invalid pending setup data' },
        { status: 400 }
      );
    }

    // Check if setup expired
    const expiresAt = pendingData.expiresAt?.toDate?.() || new Date(pendingData.expiresAt);
    if (expiresAt < new Date()) {
      await db.collection('mfa_pending').doc(userId).delete();
      return NextResponse.json(
        { error: 'Setup expired. Please start again.' },
        { status: 400 }
      );
    }

    // Verify TOTP code
    const secret = pendingData.secret;
    const isValid = verifyTOTP(code, secret);

    if (!isValid) {
      return NextResponse.json(
        { error: 'Invalid verification code. Please try again.' },
        { status: 400 }
      );
    }

    // Encrypt the secret for storage
    const encryptedSecret = encrypt(secret);

    // The sheet. THIS IS THE ONE PLACE recovery codes are issued without a
    // separate proof of possession, and the exception is bounded by the two
    // facts that make it safe: the caller has just verified a TOTP code for the
    // factor being enrolled a few lines above, and the enrollment gate has
    // already refused any account that holds a factor on an unverified session.
    // Every OTHER issuance goes through `POST /api/mfa/backup-codes`, which
    // demands live proof and has no bypass. Do not generalise this branch.
    //
    // Server-side generation (`issueBackupCodes`) is the destination; the
    // client-supplied array is the transitional path for today's
    // `app/setup-2fa/page.tsx`, which mints the codes in the browser and is
    // already displaying them. Wave 4 moves that page onto `BackupCodesPanel`
    // fed by the `backupCodes` field in this response, and the parameter goes.
    const issued: IssuedBackupCodes = Array.isArray(backupCodes)
      ? { plaintext: backupCodes, hashed: backupCodes.map(hashBackupCode) }
      : issueBackupCodes();
    const hashedBackupCodes = issued.hashed;

    // Save the encrypted MFA configuration. The factor inventory module is
    // the ONLY writer of `mfaEnrolled` / `requiresMfaSetup` — it derives both
    // from the resulting inventory and folds them into the same merge write as
    // the secret, so the account can never be left holding a secret without
    // the flags (or the flags without a secret).
    const factorResult = await applyMfaFactorChange(
      userId,
      { totp: true },
      {
        extraUpdate: {
          mfaSecret: encryptedSecret, // Now encrypted!
          backupCodes: hashedBackupCodes,
          // Stamped alongside the sheet so account settings can show its age
          // and `/api/mfa/backup-codes` has a single field to advance on every
          // regeneration, whichever route issued the generation.
          backupCodesGeneratedAt: FieldValue.serverTimestamp(),
          mfaEnrolledAt: FieldValue.serverTimestamp(),
        },
      },
    );

    // Delete pending setup
    await db.collection('mfa_pending').doc(userId).delete();

    // The user just proved possession of the new factor — promote the
    // session straight to MFA-verified so they don't get bounced to the
    // verify-2fa page on the next protected-path navigation. From this
    // point on, `users/{uid}.mfaEnrolled === true` so every subsequent
    // session-create will require a fresh challenge.
    await markSessionMfaVerified();

    // Audit. Platform-tenant mutation (siteId = '') so the cloud function
    // records it on the platform partition, not under any specific site.
    // Mirrors the `mfa_disabled` row emitted by /api/mfa/disable so a factor
    // add and a factor remove are both visible on the account's timeline.
    emitMutation({
      kind: 'user_mutated',
      siteId: '',
      actor: `user:${userId}`,
      targetId: userId,
      attributes: {
        endpoint: '/api/mfa/verify-setup',
        method: 'POST',
        verb: 'mfa_enrolled',
        factor: 'totp',
        backupCodesIssued: hashedBackupCodes.length,
        passkeysEnrolled: factorResult.factors.passkeys,
      },
    });

    // The plaintext sheet, returned exactly once — only hashes were stored.
    // Echoing back a client-supplied set is harmless (the caller sent it in
    // this request), and it gives both paths one contract for wave 4's
    // `BackupCodesPanel` to render.
    return NextResponse.json({
      success: true,
      backupCodes: issued.plaintext,
    });
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'mfa/verify-setup');
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});
