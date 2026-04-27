import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';

type RouteParams = {
  siteId: string;
} & Record<string, string | undefined>;

export const dynamic = 'force-dynamic';

/**
 * GET /api/sites/{siteId}/agent-tokens
 *
 * List all agent refresh tokens for a site.
 */
export const GET = authorizedSiteHandler<RouteParams>({
  capability: 'GLOBAL_SETTINGS_WRITE',
  siteIdParam: 'path',
  apiKeyPermission: 'read',
})(async (_request: NextRequest, ctx) => {
  try {
    const siteId = ctx.siteId;
    const db = adminDb.value;

    const tokensSnapshot = await db.collection('agent_refresh_tokens')
      .where('siteId', '==', siteId)
      .get();

    const tokens = tokensSnapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        machineId: data.machineId,
        version: data.version,
        createdBy: data.createdBy,
        createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
        lastUsed: data.lastUsed?.toDate?.()?.toISOString() || null,
        expiresAt: data.expiresAt?.toDate?.()?.toISOString() || null,
        agentUid: data.agentUid,
      };
    });

    tokens.sort((a, b) => {
      if (!a.createdAt) return 1;
      if (!b.createdAt) return -1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    return NextResponse.json(
      {
        tokens,
        count: tokens.length,
      },
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    );
  } catch (error: unknown) {
    return apiError(error, 'sites/agent-tokens:list');
  }
});
