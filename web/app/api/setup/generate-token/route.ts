import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, assertUserHasSiteAccess, requireSession } from '@/lib/apiAuth.server';
import { apiError } from '@/lib/apiErrorResponse';
import { emitMutation } from '@/lib/auditLogClient';
import logger from '@/lib/logger';

/**
 * POST /api/setup/generate-token — mint a registration code for agent OAuth, stored in
 * Firestore for validation during token exchange.
 *
 * Body: `{ siteId, userId (deprecated — derived from session) }`.
 * Response: `{ token }` — the registration code, 24h expiry.
 *
 * Audits `site_mutated` / `agent_token.issue`, same row shape as
 * `/api/agent/generate-installer`. The `agent_tokens` doc id IS the registration
 * code, so the row targets the site and never carries the code.
 */
export const POST = withRateLimit(async (request: NextRequest) => {
  try {
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

    const expiresAt = Timestamp.fromDate(new Date(Date.now() + 24 * 60 * 60 * 1000)); // 24 hour expiry

    await adminDb.value.collection('agent_tokens').doc(registrationCode).set({
      siteId,
      createdBy: userId,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt,
      used: false,
    });

    logger.info(`Generated registration code for site ${siteId} by user ${userId}`);

    emitMutation({
      kind: 'site_mutated',
      siteId,
      actor: `user:${userId}`,
      targetId: siteId,
      attributes: {
        verb: 'agent_token.issue',
        endpoint: '/api/setup/generate-token',
        method: 'POST',
        siteId,
        expiresAt: expiresAt.toDate().toISOString(),
      },
    });

    return NextResponse.json(
      {
        token: registrationCode, // "token" field for backward compatibility with setup page
        siteId,
        userId,
      },
      { status: 200 }
    );

  } catch (error: unknown) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'setup/generate-token');
  }
}, {
  strategy: 'api',
  identifier: 'ip',
});
