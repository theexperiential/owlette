/**
 * MFA Verify Login API
 *
 * Verifies TOTP code during login (server-side)
 * Decrypts the stored secret, verifies the code, never exposes secret to client
 *
 * POST /api/mfa/verify-login
 * Request: { userId: string, code: string, isBackupCode?: boolean }
 * Response: { success: boolean, backupCodeUsed?: boolean }
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
import admin from 'firebase-admin';
import { ApiAuthError, requireSessionUser } from '@/lib/apiAuth.server';
import { apiError } from '@/lib/apiErrorResponse';

export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const body = await request.json();
    const { userId, code, isBackupCode = false } = body;

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

    const db = getAdminDb();

    // Get user's MFA configuration
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    const userData = userDoc.data();
    if (!userData) {
      return NextResponse.json(
        { error: 'Invalid user data' },
        { status: 400 }
      );
    }

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
      const backupCodes = userData.backupCodes || [];
      const normalizedCode = code.toUpperCase().trim();

      const matchingCodeIndex = backupCodes.findIndex((hash: string) =>
        verifyBackupCode(normalizedCode, hash)
      );

      if (matchingCodeIndex !== -1) {
        isValid = true;
        backupCodeUsed = true;

        // Remove used backup code
        await db.collection('users').doc(userId).update({
          backupCodes: admin.firestore.FieldValue.arrayRemove(backupCodes[matchingCodeIndex]),
        });
      }
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

    return NextResponse.json({
      success: true,
      backupCodeUsed,
    });
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
