import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import { isTokenDead, isTokenLive } from '@/lib/agentTokens';

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

    // The collection accumulates rotated-away (superseded) and expired
    // docs — one dead doc per hourly refresh for 2.12.0+ agents. Return
    // only live credentials and report how many dead docs exist so the
    // admin can prune them. See lib/agentTokens.ts for the definitions.
    const now = Date.now();
    let prunableCount = 0;
    const tokens: Array<{
      id: string;
      machineId: string;
      version: string;
      createdBy: string;
      createdAt: string | null;
      lastUsed: string | null;
      expiresAt: string | null;
      agentUid: string;
    }> = [];

    for (const doc of tokensSnapshot.docs) {
      const data = doc.data();
      if (isTokenDead(data, now)) {
        // Superseded past its grace window, or expired: safe to prune.
        prunableCount++;
        continue;
      }
      if (!isTokenLive(data, now)) {
        // Superseded but still within its 5-minute grace window — its
        // successor is already the live row, so skip this transient
        // duplicate (not shown, not counted as prunable).
        continue;
      }
      tokens.push({
        id: doc.id,
        machineId: data.machineId,
        version: data.version,
        createdBy: data.createdBy,
        createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
        lastUsed: data.lastUsed?.toDate?.()?.toISOString() || null,
        expiresAt: data.expiresAt?.toDate?.()?.toISOString() || null,
        agentUid: data.agentUid,
      });
    }

    tokens.sort((a, b) => {
      if (!a.createdAt) return 1;
      if (!b.createdAt) return -1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    return NextResponse.json(
      {
        tokens,
        count: tokens.length,
        prunableCount,
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
