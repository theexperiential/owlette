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
 *
 * SECURITY: adding a factor to an account that already holds one requires an
 * MFA-verified session — see `lib/mfaEnrollmentGate.server.ts` for the bypass this closes.
 * Minting a pending secret is not yet a state change the attacker can use, but
 * gating here means the flow fails at step one with an actionable code instead
 * of walking the user through a QR scan that verify-setup will reject.
 */

import { NextRequest, NextResponse } from 'next/server';
import { generateTOTPSecret, generateQRCode } from '@/lib/totp';
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, assertActiveUser, requireSessionUser } from '@/lib/apiAuth.server';
import { apiError } from '@/lib/apiErrorResponse';
import { checkMfaEnrollmentGate } from '@/lib/mfaEnrollmentGate.server';

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
    await assertActiveUser(userId);

    // Enrollment gate: open while the account has no factor at all (the
    // mandatory-setup path), MFA-verified session required once it does.
    const gate = await checkMfaEnrollmentGate(userId);
    if (gate.denied) {
      return gate.denied;
    }

    const db = getAdminDb();

    // IDEMPOTENT: reuse an existing, unexpired pending secret rather than
    // minting a fresh one on every call.
    //
    // This route is not called once. `app/setup-2fa/page.tsx` fires it from an
    // effect, and anything that re-runs that effect — a refresh, a remount, a
    // second render pass — issues a second POST. Minting a new secret each time
    // means the LAST write wins in `mfa_pending` while the FIRST response may
    // be the one whose QR the user actually scanned, so verify-setup then
    // rejects a code the user read correctly off their authenticator. That race
    // made the setup-2fa e2e spec fail roughly half the time.
    //
    // Reuse is also the better user-facing behaviour: refreshing the page
    // mid-scan should not silently invalidate the QR you are looking at.
    // Expiry is unchanged — a stale pending doc falls through to a fresh
    // secret below, and verify-setup still enforces `expiresAt` itself.
    const pendingRef = db.collection('mfa_pending').doc(userId);
    const pending = await pendingRef.get();
    const pendingData = pending.exists ? pending.data() : undefined;
    const pendingExpiresAt =
      pendingData?.expiresAt?.toDate?.() ??
      (pendingData?.expiresAt ? new Date(pendingData.expiresAt) : undefined);
    const reusableSecret =
      typeof pendingData?.secret === 'string' &&
      pendingExpiresAt instanceof Date &&
      pendingExpiresAt > new Date()
        ? pendingData.secret
        : null;

    if (reusableSecret) {
      return NextResponse.json({
        secret: reusableSecret,
        qrCodeUrl: await generateQRCode(email, reusableSecret),
      });
    }

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
      await pendingRef.set({
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
    return apiError(error, 'mfa/setup');
  }
}, {
  strategy: 'auth',
  identifier: 'ip',
});
