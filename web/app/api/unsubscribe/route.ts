import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';

/**
 * GET /api/unsubscribe?token=...
 *
 * One-click unsubscribe from health alert emails.
 * Token is HMAC-signed userId so no authentication is needed.
 */

function getSecret(): string {
  return process.env.CRON_SECRET || 'owlette-unsubscribe-fallback';
}

/** Generate a signed unsubscribe token for a userId */
export function generateUnsubscribeToken(userId: string): string {
  const hmac = crypto.createHmac('sha256', getSecret());
  hmac.update(userId);
  const signature = hmac.digest('hex');
  // Encode as base64url: userId:signature
  return Buffer.from(`${userId}:${signature}`).toString('base64url');
}

/** Verify and extract userId from a token */
function verifyToken(token: string): string | null {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf-8');
    const colonIdx = decoded.lastIndexOf(':');
    if (colonIdx === -1) return null;

    const userId = decoded.substring(0, colonIdx);
    const signature = decoded.substring(colonIdx + 1);

    const hmac = crypto.createHmac('sha256', getSecret());
    hmac.update(userId);
    const expected = hmac.digest('hex');

    if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return userId;
    }
    return null;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');

  if (!token) {
    return NextResponse.json({ error: 'Missing token' }, { status: 400 });
  }

  const userId = verifyToken(token);
  if (!userId) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 400 });
  }

  try {
    const db = getAdminDb();
    await db.collection('users').doc(userId).set(
      { preferences: { healthAlerts: false } },
      { merge: true }
    );

    // Redirect to a confirmation page
    const baseUrl = request.nextUrl.origin;
    return NextResponse.redirect(`${baseUrl}/unsubscribe?success=true`);
  } catch (error) {
    return apiError(error, 'unsubscribe');
  }
}
