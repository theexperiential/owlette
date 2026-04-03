/**
 * MFA Setup API
 *
 * Generates TOTP secret and QR code for 2FA setup
 * The secret is temporarily stored server-side until verification
 *
 * POST /api/mfa/setup
 * Request: { userId: string, email: string }
 * Response: { secret: string, qrCodeUrl: string }
 *
 * SECURITY: The secret returned here is for display only.
 * The actual storage happens in /api/mfa/verify-setup after verification.
 */

import { NextRequest, NextResponse } from 'next/server';
import { generateTOTPSecret, generateQRCode } from '@/lib/totp';
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, requireSessionUser } from '@/lib/apiAuth.server';

export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    const body = await request.json();
    const { userId, email } = body;

    // Validate inputs
    if (!userId || typeof userId !== 'string') {
      return NextResponse.json(
        { error: 'Invalid user ID' },
        { status: 400 }
      );
    }

    if (!email || typeof email !== 'string') {
      return NextResponse.json(
        { error: 'Invalid email' },
        { status: 400 }
      );
    }

    await requireSessionUser(request, userId);

    // Generate TOTP secret
    let secret: string;
    try {
      secret = generateTOTPSecret();
    } catch (e) {
      console.error('[MFA Setup] generateTOTPSecret failed:', e);
      throw e;
    }

    // Generate QR code
    let qrCodeUrl: string;
    try {
      qrCodeUrl = await generateQRCode(email, secret);
    } catch (e) {
      console.error('[MFA Setup] generateQRCode failed:', e);
      throw e;
    }

    // Store pending setup in Firestore (temporary, expires in 10 minutes)
    try {
      const db = getAdminDb();
      await db.collection('mfa_pending').doc(userId).set({
        secret,
        email,
        createdAt: FieldValue.serverTimestamp(),
        expiresAt: Timestamp.fromDate(new Date(Date.now() + 10 * 60 * 1000)), // 10 minutes
      });
    } catch (e) {
      console.error('[MFA Setup] Firestore write failed:', e);
      throw e;
    }

    return NextResponse.json({
      secret,
      qrCodeUrl,
    });
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : 'Failed to generate MFA setup';
    console.error('[MFA Setup] Error:', error);
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});
