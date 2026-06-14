/**
 * POST /api/auth/forgot-password
 *
 * Sends a BRANDED password-reset email through Owlette's Resend pipeline
 * instead of Firebase's plain built-in template.
 *
 * Flow:
 *   1. Admin SDK generatePasswordResetLink(email) mints a reset oobCode
 *      WITHOUT sending Firebase's own email.
 *   2. We extract the oobCode and build an in-app /reset-password link so the
 *      whole flow (email AND the page where the user sets a new password)
 *      stays on-brand. No Firebase continue-URL / authorized-domain dependency.
 *   3. We send our own branded email (wrapEmailLayout) via Resend.
 *
 * Enumeration-safe: generatePasswordResetLink throws 'auth/user-not-found' for
 * unknown addresses (unlike the client SDK under enumeration protection). We
 * swallow that and respond 200 either way, so the response never reveals
 * whether an account exists. Only malformed input gets a 400.
 *
 * Rate limited per IP (auth strategy) — this is a public, unauthenticated
 * surface, so it's the abuse boundary for reset-email sends.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { getAdminAuth } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';
import { getResend, FROM_EMAIL, isProduction } from '@/lib/resendClient.server';
import { buildPasswordResetEmail } from '@/lib/emailTemplates.server';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Trusted base URL for the reset link. Deliberately NOT derived from the
 * request Host header — that would let an attacker host-inject a malicious
 * reset link carrying a valid oobCode (account takeover). Server env only.
 */
function trustedBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_BASE_URL ||
    (isProduction ? 'https://owlette.app' : 'https://dev.owlette.app')
  );
}

export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      const body = await request.json().catch(() => null);
      const email = typeof body?.email === 'string' ? body.email.trim() : '';

      if (!email || !EMAIL_RE.test(email)) {
        return NextResponse.json({ error: 'Missing or invalid email' }, { status: 400 });
      }

      // Check the account exists FIRST. getUserByEmail throws a stable,
      // documented 'auth/user-not-found' for unknown addresses — whereas
      // generatePasswordResetLink throws an opaque 'auth/internal-error'
      // ("Unable to create the email action link") for non-existent users on
      // REAL Firebase (the emulator throws user-not-found, which is why this
      // gap slipped past e2e + review). Without this explicit check, unknown
      // emails would 500 while real ones 200 — an account-enumeration oracle.
      // Pre-checking keeps the unknown-email response identical to success and
      // lets a genuine link-gen failure for a real account surface as a 500.
      try {
        await getAdminAuth().getUserByEmail(email);
      } catch (err: unknown) {
        if ((err as { code?: string } | null)?.code === 'auth/user-not-found') {
          // No account — respond exactly as the success case (send nothing).
          return NextResponse.json({ success: true });
        }
        throw err;
      }

      // Account exists — mint the reset link server-side WITHOUT triggering
      // Firebase's own email.
      const link = await getAdminAuth().generatePasswordResetLink(email);
      const oobCode = new URL(link).searchParams.get('oobCode');
      if (!oobCode) {
        // Link generated but no oobCode parsed — unexpected; surface as 500.
        throw new Error('generatePasswordResetLink returned a link with no oobCode');
      }

      const resetUrl = `${trustedBaseUrl()}/reset-password?oobCode=${encodeURIComponent(oobCode)}`;

      // Send the branded email. If Resend isn't configured (local dev / E2E),
      // skip the send but still respond 200 — the reset code was minted and the
      // contract (existence-agnostic success) is preserved.
      const resend = getResend();
      if (resend) {
        const { error } = await resend.emails.send({
          from: FROM_EMAIL,
          to: email,
          subject: 'reset your owlette password',
          html: buildPasswordResetEmail(resetUrl),
        });
        if (error) throw error;
      } else if (isProduction) {
        // Should never happen in prod — surface at error level so a missing
        // RESEND_API_KEY can't silently black-hole resets behind a "link is on
        // its way" confirmation. (Dev/E2E intentionally run without Resend.)
        console.error('[forgot-password] RESEND_API_KEY not configured in production — reset email NOT sent');
      } else {
        console.warn('[forgot-password] RESEND_API_KEY not configured — reset email not sent (dev/e2e)');
      }

      return NextResponse.json({ success: true });
    } catch (error) {
      return apiError(error, 'auth/forgot-password POST');
    }
  },
  {
    strategy: 'auth',
    identifier: 'ip',
  },
);
