/**
 * MFA Disable API
 *
 * Server-mediated disable of MFA on the current user's account. Because
 * Wave 1B locked the user-doc write rules so a client can no longer mutate
 * `mfaEnrolled` / `mfaSecret` / `backupCodes` from the browser console
 * (see `firestore.rules` — diff().affectedKeys().hasOnly([...]) allowlist),
 * the only path to disable MFA is through this admin-SDK route.
 *
 * POST /api/mfa/disable
 * Request: { code: string, isBackupCode?: boolean }
 *   - `code` must be either:
 *       a current TOTP code from the user's authenticator (default), OR
 *       a valid backup code (set `isBackupCode: true`).
 *   - Session cookie must be authenticated AND match the userId encoded
 *     in the session — there is no `userId` parameter, the route always
 *     operates on the session's own user.
 *   - Rate-limited via the shared `auth` strategy (10 req / min / IP).
 *
 * Response (200):
 *   {
 *     "success": true,
 *     "backupCodeUsed": boolean
 *   }
 *
 * Failure modes:
 *   - 400 missing/invalid code, MFA not enrolled, bad backup code.
 *   - 401 no valid session.
 *   - 404 user document not found (shouldn't happen for a valid session).
 *   - 500 MFA encryption key not configured (operator misconfiguration).
 *
 * On success, this route:
 *   1. Verifies the supplied factor (TOTP or backup code).
 *   2. In a single Firestore update, clears `mfaEnrolled`, `mfaSecret`,
 *      and `backupCodes` and stamps `mfaDisabledAt`.
 *   3. Re-mints the session cookie via `markSessionMfaDisabled` so the
 *      user is not immediately bounced to /verify-2fa (the just-completed
 *      proof of possession satisfies the gate).
 *   4. Emits a `user_mutated` audit row with verb `mfa_disabled` so the
 *      event is captured even though the platform-tenant has no siteId.
 *
 * SECURITY:
 *   - Admin SDK bypasses Firestore rules (rules block this write from any
 *     client-mediated path). This is intentional: the rule is the safety
 *     net; this route is the only authorized way to flip those fields.
 *   - No re-auth shortcut: the user must prove the second factor every
 *     time. If they've lost both TOTP and all backup codes, account
 *     recovery is a manual support process.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyTOTP, verifyBackupCode } from '@/lib/totp';
import { decrypt, isEncryptionConfigured } from '@/lib/encryption.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { withRateLimit } from '@/lib/withRateLimit';
import {
  ApiAuthError,
  assertActiveUser,
  requireSession,
} from '@/lib/apiAuth.server';
import { apiError } from '@/lib/apiErrorResponse';
import { markSessionMfaDisabled } from '@/lib/sessionManager.server';
import { emitMutation } from '@/lib/auditLogClient';

export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const body = await request.json().catch(() => ({}));
    const { code, isBackupCode = false } = body as {
      code?: unknown;
      isBackupCode?: unknown;
    };

    if (!code || typeof code !== 'string') {
      return NextResponse.json(
        { error: 'Invalid verification code' },
        { status: 400 }
      );
    }
    const useBackup = isBackupCode === true;
    if (!useBackup && code.length !== 6) {
      return NextResponse.json(
        { error: 'TOTP code must be 6 digits' },
        { status: 400 }
      );
    }

    // The session is authoritative for which user we're operating on — we
    // intentionally do NOT accept a userId from the request body, so this
    // route can never be redirected against another account.
    const userId = await requireSession(request);

    const userData = await assertActiveUser(userId);
    const db = getAdminDb();
    const userRef = db.collection('users').doc(userId);

    if (!userData.mfaEnrolled) {
      return NextResponse.json(
        { error: 'MFA is not enrolled for this account' },
        { status: 400 }
      );
    }

    let backupCodeUsed = false;

    if (useBackup) {
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
        // We're about to wipe backupCodes anyway in the disable-write
        // below, but consume the code inside the transaction so a
        // mid-flight crash between verification and the wipe doesn't
        // leave the backup code re-usable.
        const remaining = codes.filter((_, i) => i !== idx);
        tx.update(userRef, { backupCodes: remaining });
        return { ok: true } as const;
      });

      if (!consumed.ok) {
        if (consumed.reason === 'no_user') {
          return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }
        return NextResponse.json(
          { error: 'Invalid verification code' },
          { status: 400 }
        );
      }
      backupCodeUsed = true;
    } else {
      const encryptedSecret = userData.mfaSecret;
      if (!encryptedSecret || typeof encryptedSecret !== 'string') {
        return NextResponse.json(
          { error: 'MFA secret not found' },
          { status: 400 }
        );
      }

      let secret: string;
      if (encryptedSecret.includes(':')) {
        if (!isEncryptionConfigured()) {
          console.error('[MFA Disable] MFA_ENCRYPTION_KEY not configured');
          return NextResponse.json(
            { error: 'MFA encryption not configured' },
            { status: 500 }
          );
        }
        secret = decrypt(encryptedSecret);
      } else {
        // Legacy unencrypted format — same handling as verify-login.
        secret = encryptedSecret;
      }

      if (!verifyTOTP(code, secret)) {
        return NextResponse.json(
          { error: 'Invalid verification code' },
          { status: 400 }
        );
      }
    }

    // Verified. Tear down MFA in a single update so partial failure can't
    // leave the user with `mfaEnrolled: true, mfaSecret: null` (which
    // would make verify-login error out and lock the user out of their
    // own account).
    await userRef.update({
      mfaEnrolled: false,
      mfaSecret: FieldValue.delete(),
      backupCodes: [],
      mfaDisabledAt: FieldValue.serverTimestamp(),
      // Clear the setup-nag flag too — the user has demonstrated they
      // can use MFA, so we don't want to immediately nag them to re-enroll.
      requiresMfaSetup: false,
    });

    // Re-mint the session. The user just proved possession of a factor,
    // so we keep them signed in without forcing a re-challenge against
    // an MFA configuration that no longer exists.
    await markSessionMfaDisabled();

    // Audit. Platform-tenant mutation (siteId = '') so the cloud function
    // records it on the platform partition, not under any specific site.
    emitMutation({
      kind: 'user_mutated',
      siteId: '',
      actor: `user:${userId}`,
      targetId: userId,
      attributes: {
        endpoint: '/api/mfa/disable',
        method: 'POST',
        verb: 'mfa_disabled',
        factorUsed: useBackup ? 'backup_code' : 'totp',
      },
    });

    return NextResponse.json({ success: true, backupCodeUsed });
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'mfa/disable');
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});
