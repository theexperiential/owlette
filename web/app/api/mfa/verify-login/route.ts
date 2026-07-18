/**
 * MFA Verify Login API
 *
 * Verifies TOTP code during login (server-side)
 * Decrypts the stored secret, verifies the code, never exposes secret to client
 *
 * POST /api/mfa/verify-login
 * Request: { userId: string, code: string, isBackupCode?: boolean, trustDevice?: boolean }
 * Response: { success: boolean, backupCodeUsed: boolean, deviceTrusted: boolean }
 *
 * SECURITY:
 * - Secret is decrypted only server-side
 * - Secret is never sent to the client
 * - Backup codes are removed after use
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyTOTP, verifyBackupCode } from '@/lib/totp';
import { decrypt, isEncryptionConfigured } from '@/lib/encryption.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, assertActiveUser, requireSessionUser } from '@/lib/apiAuth.server';
import { apiError } from '@/lib/apiErrorResponse';
import { markSessionMfaVerified } from '@/lib/sessionManager.server';
import {
  createTrustedDevice,
  mintDeviceTrustToken,
  DEVICE_TRUST_COOKIE,
  deviceTrustCookieOptions,
} from '@/lib/deviceTrust.server';

export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const body = await request.json();
    const { userId, code, isBackupCode = false, trustDevice = false } = body;

    // Validate inputs
    if (!userId || typeof userId !== 'string') {
      return NextResponse.json(
        { error: 'Invalid user ID' },
        { status: 400 }
      );
    }

    if (!code || typeof code !== 'string') {
      return NextResponse.json(
        { error: 'Invalid verification code' },
        { status: 400 }
      );
    }

    if (!isBackupCode && code.length !== 6) {
      return NextResponse.json(
        { error: 'TOTP code must be 6 digits' },
        { status: 400 }
      );
    }

    await requireSessionUser(request, userId);
    const userData = await assertActiveUser(userId);

    const db = getAdminDb();
    const userRef = db.collection('users').doc(userId);

    // Check if MFA is enrolled
    if (!userData.mfaEnrolled) {
      return NextResponse.json(
        { error: 'MFA not enrolled for this user' },
        { status: 400 }
      );
    }

    let isValid = false;
    let backupCodeUsed = false;

    if (isBackupCode) {
      // Verify backup code
      const normalizedCode = code.toUpperCase().trim();

      const consumed = await db.runTransaction(async (tx) => {
        const snap = await tx.get(userRef);
        if (!snap.exists) {
          return { ok: false, reason: 'no_user' as const };
        }

        const data = snap.data() ?? {};
        const codes: string[] = Array.isArray(data.backupCodes) ? data.backupCodes : [];
        const matchingCodeIndex = codes.findIndex((hash) =>
          verifyBackupCode(normalizedCode, hash)
        );

        if (matchingCodeIndex === -1) {
          return { ok: false, reason: 'no_match' as const };
        }

        const remaining = codes.filter((_, index) => index !== matchingCodeIndex);
        tx.update(userRef, { backupCodes: remaining });
        return { ok: true, remaining: remaining.length } as const;
      });

      if (!consumed.ok) {
        if (consumed.reason === 'no_user') {
          return NextResponse.json(
            { error: 'User not found' },
            { status: 404 }
          );
        }

        return NextResponse.json(
          { error: 'Invalid verification code' },
          { status: 400 }
        );
      }

      isValid = true;
      backupCodeUsed = true;
    } else {
      // Verify TOTP code
      const encryptedSecret = userData.mfaSecret;

      if (!encryptedSecret) {
        return NextResponse.json(
          { error: 'MFA secret not found' },
          { status: 400 }
        );
      }

      // Check if secret is encrypted (contains colons from our format)
      let secret: string;
      if (encryptedSecret.includes(':')) {
        // Encrypted format - decrypt it
        if (!isEncryptionConfigured()) {
          console.error('[MFA Verify Login] MFA_ENCRYPTION_KEY not configured');
          return NextResponse.json(
            { error: 'MFA encryption not configured' },
            { status: 500 }
          );
        }
        secret = decrypt(encryptedSecret);
      } else {
        // Legacy unencrypted format - use as-is
        // TODO: Migrate old secrets to encrypted format
        secret = encryptedSecret;
      }

      isValid = verifyTOTP(code, secret);
    }

    if (!isValid) {
      return NextResponse.json(
        { error: 'Invalid verification code' },
        { status: 400 }
      );
    }

    // Successful TOTP / backup-code verification flips the session-cookie
    // MFA gate so the proxy will allow protected paths through. This is
    // the authoritative server-side state — prior to Wave 2, this flag
    // lived in client sessionStorage and could be set without any
    // server-side check.
    await markSessionMfaVerified();

    // "Trust this device for 30 days": when the user opted in, mint an opaque
    // device-trust token, persist only its SHA-256 hash under this uid, and set
    // the raw token in an HTTPOnly cookie on the success response. A future
    // createSession() reads that cookie and is born mfaVerified without
    // re-challenging. This is keyed off the same trustDevice flag for BOTH the
    // TOTP and backup-code paths (mint happens once, here at the shared success
    // point, strictly after the isValid gate). A persistence failure must NOT
    // fail the 2FA verification itself — the user is verified regardless; only
    // the trust convenience is skipped, so we log and continue with no cookie.
    let rawTrustToken: string | null = null;
    if (trustDevice === true) {
      try {
        const { raw, hash } = mintDeviceTrustToken();
        await createTrustedDevice(
          userId,
          hash,
          request.headers.get('user-agent') ?? '',
          Date.now()
        );
        rawTrustToken = raw;
      } catch (error) {
        console.error('[MFA Verify Login] Failed to persist device trust:', error);
      }
    }

    const response = NextResponse.json({
      success: true,
      backupCodeUsed,
      deviceTrusted: rawTrustToken !== null,
    });

    if (rawTrustToken !== null) {
      response.cookies.set(
        DEVICE_TRUST_COOKIE,
        rawTrustToken,
        deviceTrustCookieOptions()
      );
    }

    return response;
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'mfa/verify-login');
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});
