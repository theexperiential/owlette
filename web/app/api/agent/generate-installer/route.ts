import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { ApiAuthError, assertUserHasSiteAccess, requireSession } from '@/lib/apiAuth.server';
import logger from '@/lib/logger';

/**
 * POST /api/agent/generate-installer
 *
 * Generate a registration code for creating a new installer.
 * This endpoint is called by authenticated users from the web dashboard
 * when they want to add a new machine to their site.
 *
 * Request body:
 * - siteId: string - Site ID to associate the agent with
 * - userId: string - Deprecated (derived from session)
 *
 * Response (200 OK):
 * - registrationCode: string - Single-use code to embed in installer
 * - expiresAt: string - ISO 8601 timestamp when code expires (24 hours)
 * - siteId: string - Site ID this code is for
 *
 * Errors:
 * - 400: Missing required fields
 * - 401: Unauthorized (no valid session)
 * - 403: Forbidden (user doesn't have access to site)
 * - 500: Server error
 */
export async function POST(request: NextRequest) {
  try {
    // Parse request body
    const body = await request.json();
    const { siteId } = body;

    if (!siteId) {
      return NextResponse.json(
        { error: 'Missing required field: siteId' },
        { status: 400 }
      );
    }

    const userId = await requireSession(request);

    // Verify user has access to the site
    await assertUserHasSiteAccess(userId, siteId);

    // Generate cryptographically secure registration code
    const crypto = await import('crypto');
    const registrationCode = crypto.randomBytes(32).toString('base64url');

    // Calculate expiration (24 hours from now)
    const now = Date.now();
    const expiresAt = new Date(now + 24 * 60 * 60 * 1000);

    // Store registration code in Firestore
    const adminDb = getAdminDb();
    await adminDb.collection('agent_tokens').doc(registrationCode).set({
      siteId,
      createdBy: userId,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt,
      used: false,
      status: 'pending',
    });

    logger.info(`Registration code generated: site=${siteId}, user=${userId}, expires=${expiresAt.toISOString()}`);

    return NextResponse.json(
      {
        registrationCode,
        expiresAt: expiresAt.toISOString(),
        siteId,
      },
      { status: 200 }
    );

  } catch (error: any) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('Error generating registration code:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
