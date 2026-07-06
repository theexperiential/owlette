import { NextRequest, NextResponse } from 'next/server';
import type { Firestore, DocumentReference, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { adminDb } from '@/lib/firebase-admin';
import { withRateLimit } from '@/lib/withRateLimit';
import { apiError } from '@/lib/apiErrorResponse';
import logger from '@/lib/logger';
import { isTokenDead, tokenTimestampToMillis } from '@/lib/agentTokens';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';

type RouteParams = {
  siteId: string;
} & Record<string, string | undefined>;

/**
 * Delete document refs in Firestore batches. A single write batch is capped
 * at 500 ops; sites that accumulated thousands of rotated/dead token docs
 * blow past that, so revoke-all and prune must chunk. 450 leaves headroom.
 */
async function deleteRefsInChunks(
  db: Firestore,
  refs: DocumentReference[],
): Promise<number> {
  const CHUNK_SIZE = 450;
  for (let i = 0; i < refs.length; i += CHUNK_SIZE) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + CHUNK_SIZE)) {
      batch.delete(ref);
    }
    await batch.commit();
  }
  return refs.length;
}

/**
 * POST /api/sites/{siteId}/agent-tokens/revoke
 *
 * Revoke agent refresh tokens for a site, machine, or individual token id,
 * or prune only the provably-dead (superseded-and-retired / expired) docs.
 */
export const POST = withRateLimit(authorizedSiteHandler<RouteParams>({
  capability: 'GLOBAL_SETTINGS_WRITE',
  siteIdParam: 'path',
})(async (request: NextRequest, ctx) => {
  try {
    const body = await request.json();
    const { tokenId, machineId, all, prune, latestOnly } = body;
    const siteId = ctx.siteId;

    // Exactly one primary revoke mode may be set. latestOnly is a MODIFIER of
    // the machineId mode — reject it standalone or mixed with a bulk mode so a
    // precise ({ machineId, latestOnly }) request can never fall through to a
    // broader all/prune delete because of branch ordering.
    const modeCount = [tokenId, machineId, all, prune].filter(Boolean).length;
    if (modeCount === 0) {
      return NextResponse.json(
        { error: 'Must specify tokenId, machineId, all: true, or prune: true' },
        { status: 400 },
      );
    }
    if (modeCount > 1) {
      return NextResponse.json(
        { error: 'Specify exactly one of tokenId, machineId, all, or prune' },
        { status: 400 },
      );
    }
    if (latestOnly && !machineId) {
      return NextResponse.json(
        { error: 'latestOnly is only valid together with machineId' },
        { status: 400 },
      );
    }

    const db = adminDb.value;
    let revokedCount = 0;

    if (prune) {
      // Delete only provably-dead docs (superseded past their grace window,
      // or expired). Live tokens — including every agent's current
      // credential and any in-grace rotation — are never touched, so this
      // is safe to run at any time to reclaim the accumulated bloat.
      const tokensSnapshot = await db.collection('agent_refresh_tokens')
        .where('siteId', '==', siteId)
        .get();

      const now = Date.now();
      const deadRefs = tokensSnapshot.docs
        .filter((doc) => isTokenDead(doc.data(), now))
        .map((doc) => doc.ref);

      revokedCount = await deleteRefsInChunks(db, deadRefs);

      logger.info(`Pruned ${revokedCount} dead tokens for site ${siteId}`);

      return NextResponse.json({
        success: true,
        revokedCount,
        message: revokedCount > 0
          ? `Pruned ${revokedCount} dead token(s) for site ${siteId}`
          : `No dead tokens to prune for site ${siteId}`,
      });
    } else if (all) {
      const tokensSnapshot = await db.collection('agent_refresh_tokens')
        .where('siteId', '==', siteId)
        .get();

      revokedCount = await deleteRefsInChunks(
        db,
        tokensSnapshot.docs.map((doc) => doc.ref),
      );

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

      if (latestOnly) {
        // Precise revoke: delete only the single most-recently-used LIVE token
        // for this machineId — the credential the currently-connected agent is
        // using. Preserves sibling tokens that share this hostname (distinct
        // machines cloned to the same name, or older re-pairs), so revoking one
        // machine can't disconnect another. lastUsed is the primary key
        // (createdAt only breaks ties) so we never mix timestamp scales.
        const now = Date.now();
        let pick: QueryDocumentSnapshot | null = null;
        let pickLast = -Infinity;
        let pickCreated = -Infinity;
        for (const doc of tokensSnapshot.docs) {
          const data = doc.data();
          if (isTokenDead(data, now)) continue;
          const last = tokenTimestampToMillis(data.lastUsed) ?? 0;
          const created = tokenTimestampToMillis(data.createdAt) ?? 0;
          if (last > pickLast || (last === pickLast && created > pickCreated)) {
            pick = doc;
            pickLast = last;
            pickCreated = created;
          }
        }

        revokedCount = await deleteRefsInChunks(db, pick ? [pick.ref] : []);

        logger.info(`Revoked ${revokedCount} current token for machine ${machineId} in site ${siteId}`);

        return NextResponse.json({
          success: true,
          revokedCount,
          message: revokedCount > 0
            ? `Revoked the current token for machine ${machineId}`
            : `No live token found for machine ${machineId}`,
        });
      }

      revokedCount = await deleteRefsInChunks(
        db,
        tokensSnapshot.docs.map((doc) => doc.ref),
      );

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
