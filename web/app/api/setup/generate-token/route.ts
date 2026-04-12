import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, assertUserHasSiteAccess, requireSession } from '@/lib/apiAuth.server';
import { apiError } from '@/lib/apiErrorResponse';
import logger from '@/lib/logger';

/**
 * POST /api/setup/generate-token
 *
 * Generates a registration code for agent OAuth authentication.
 * Saves the code to Firestore for validation during token exchange.
 *
 * Request body:
 * - siteId: string - The site ID the agent will be associated with
 * - userId: string - Deprecated (derived from session)
 *
 * Response:
 * - token: string - Registration code to pass to the agent (24h expiry)
 */
export const POST = withRateLimit(async (request: NextRequest) => {
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
    await assertUserHasSiteAccess(userId, siteId);

    // Generate a secure registration code (URL-safe)
    const crypto = await import('crypto');
    const codeBytes = crypto.randomBytes(32);
    const registrationCode = codeBytes.toString('base64url');

    // Save registration code to Firestore
    const expiresAt = Timestamp.fromDate(new Date(Date.now() + 24 * 60 * 60 * 1000)); // 24 hour expiry

    await adminDb.value.collection('agent_tokens').doc(registrationCode).set({
      siteId,
      createdBy: userId,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt,
      used: false,
    });

    logger.info(`Generated registration code for site ${siteId} by user ${userId}`);

    return NextResponse.json(
      {
        token: registrationCode, // "token" field for backward compatibility with setup page
        siteId,
        userId,
      },
      { status: 200 }
    );

  } catch (error: any) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'setup/generate-token');
  }
}, {
  strategy: 'api',
  identifier: 'ip',
});
