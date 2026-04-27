import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { withRateLimit } from '@/lib/withRateLimit';
import { apiError } from '@/lib/apiErrorResponse';
import logger from '@/lib/logger';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';

type RouteParams = {
  siteId: string;
} & Record<string, string | undefined>;

/**
 * POST /api/sites/{siteId}/agent-tokens/revoke
 *
 * Revoke agent refresh tokens for a site, machine, or individual token id.
 */
export const POST = withRateLimit(authorizedSiteHandler<RouteParams>({
  capability: 'GLOBAL_SETTINGS_WRITE',
  siteIdParam: 'path',
})(async (request: NextRequest, ctx) => {
  try {
    const body = await request.json();
    const { tokenId, machineId, all } = body;
    const siteId = ctx.siteId;

    if (!tokenId && !machineId && !all) {
      return NextResponse.json(
        { error: 'Must specify tokenId, machineId, or all: true' },
        { status: 400 },
      );
    }

    const db = adminDb.value;
    let revokedCount = 0;

    if (all) {
      const tokensSnapshot = await db.collection('agent_refresh_tokens')
        .where('siteId', '==', siteId)
        .get();

      const batch = db.batch();
      tokensSnapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
        revokedCount++;
      });

      if (revokedCount > 0) {
        await batch.commit();
      }

      logger.info(`Revoked ${revokedCount} tokens for site ${siteId}`);

      return NextResponse.json({
        success: true,
        revokedCount,
        message: `Revoked all ${revokedCount} tokens for site ${siteId}`,
      });
    } else if (tokenId) {
      const tokenRef = db.collection('agent_refresh_tokens').doc(tokenId);
      const tokenDoc = await tokenRef.get();

      if (!tokenDoc.exists) {
        return NextResponse.json({
          success: false,
          revokedCount: 0,
          message: 'Token not found',
        });
      }

      const tokenData = tokenDoc.data();
      if (tokenData?.siteId !== siteId) {
        return NextResponse.json(
          { error: 'Token does not belong to this site' },
          { status: 403 },
        );
      }

      await tokenRef.delete();
      revokedCount = 1;

      logger.info(`Revoked token ${tokenId} for site ${siteId}`);

      return NextResponse.json({
        success: true,
        revokedCount,
        message: `Revoked token for machine ${tokenData?.machineId || 'unknown'}`,
      });
    } else {
      const tokensSnapshot = await db.collection('agent_refresh_tokens')
        .where('siteId', '==', siteId)
        .where('machineId', '==', machineId)
        .get();

      const batch = db.batch();
      tokensSnapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
        revokedCount++;
      });

      if (revokedCount > 0) {
        await batch.commit();
      }

      logger.info(`Revoked ${revokedCount} tokens for machine ${machineId} in site ${siteId}`);

      return NextResponse.json({
        success: true,
        revokedCount,
        message: revokedCount > 0
          ? `Revoked ${revokedCount} token(s) for machine ${machineId}`
          : `No tokens found for machine ${machineId}`,
      });
    }
  } catch (error: unknown) {
    return apiError(error, 'sites/agent-tokens:revoke');
  }
}), {
  strategy: 'api',
  identifier: 'ip',
});
