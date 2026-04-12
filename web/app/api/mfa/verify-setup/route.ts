/**
 * MFA Verify Setup API
 *
 * Verifies TOTP code during setup, then encrypts and stores the secret
 *
 * POST /api/mfa/verify-setup
 * Request: { userId: string, code: string, backupCodes: string[] }
 * Response: { success: boolean }
 *
 * SECURITY:
 * - Verifies the TOTP code is correct before enabling MFA
 * - Encrypts the secret using server-side key before storing
 * - Clears pending setup data after successful verification
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyTOTP, hashBackupCode } from '@/lib/totp';
import { encrypt, isEncryptionConfigured } from '@/lib/encryption.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, requireSessionUser } from '@/lib/apiAuth.server';
import { apiError } from '@/lib/apiErrorResponse';

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

    if (!Array.isArray(backupCodes) || backupCodes.length === 0) {
      return NextResponse.json(
        { error: 'Backup codes are required' },
        { status: 400 }
      );
    }

    await requireSessionUser(request, userId);

    // Check encryption is configured
    if (!isEncryptionConfigured()) {
      console.error('[MFA Verify Setup] MFA_ENCRYPTION_KEY not configured');
      return NextResponse.json(
        { error: 'MFA encryption not configured' },
        { status: 500 }
      );
    }

    const db = getAdminDb();

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

    // Hash backup codes for storage
    const hashedBackupCodes = backupCodes.map(hashBackupCode);

    // Save encrypted MFA configuration to user document
    await db.collection('users').doc(userId).update({
      mfaEnrolled: true,
      mfaSecret: encryptedSecret, // Now encrypted!
      backupCodes: hashedBackupCodes,
      mfaEnrolledAt: FieldValue.serverTimestamp(),
      requiresMfaSetup: false,
    });

    // Delete pending setup
    await db.collection('mfa_pending').doc(userId).delete();

    return NextResponse.json({
      success: true,
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
