/**
 * POST /api/roosts/{roostId}/rollback
 *      input:  { siteId: string, targetManifestId?: string }
 *              (omit targetManifestId to roll back to previousManifestId)
 *      output: { currentManifestId, previousManifestId }
 *              → atomically swap currentManifestId → target via firestore
 *                transaction; updates previousManifestId to the old current.
 *                Fan-out cloud function (wave 2b.3) picks up the pointer
 *                change via its roost trigger.
 *
 * roost wave 2a.6.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problem,
  problemFromError,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import {
  parseJsonBody,
  validateResourceId,
  validateSiteIdBody,
  requireAuthOrProblem,
  requireSiteScope,
} from '../../../_shared';

interface RouteParams {
  params: Promise<{ roostId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requireAuthOrProblem(request);
    if (!auth.ok) return auth.response;

    const { roostId } = await params;
    const roostError = validateResourceId(roostId, 'roostId');
    if (roostError) return roostError;

    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as { siteId?: unknown; targetManifestId?: unknown };

    const site = validateSiteIdBody(body.siteId);
    if (!site.ok) return site.response;

    const scopeError = await requireSiteScope(auth.userId, site.siteId);
    if (scopeError) return scopeError;

    let explicitTarget: string | undefined;
    if (typeof body.targetManifestId === 'string') {
      const targetError = validateResourceId(body.targetManifestId, 'targetManifestId');
      if (targetError) return targetError;
      explicitTarget = body.targetManifestId;
    } else if (body.targetManifestId !== undefined) {
      return problemValidation('targetManifestId must be a string or omitted', {
        'body.targetManifestId': ['must be a string or omitted'],
      });
    }

    const db = getAdminDb();
    const roostRef = db
      .collection('sites')
      .doc(site.siteId)
      .collection('roosts')
      .doc(roostId);

    const outcome = await db.runTransaction(async (tx) => {
      const roostSnap = await tx.get(roostRef);
      if (!roostSnap.exists) {
        return { kind: 'not_found' as const };
      }
      const data = roostSnap.data() ?? {};
      const currentId = (data.currentManifestId as string | undefined) ?? null;
      const previousId = (data.previousManifestId as string | undefined) ?? null;

      const target = explicitTarget ?? previousId;
      if (!target) {
        return { kind: 'no_target' as const, currentId };
      }
      if (target === currentId) {
        return { kind: 'already_on' as const, currentId };
      }

      // Confirm the target exists in history — can't roll back to a
      // manifest that was never published.
      const targetRef = roostRef.collection('manifests').doc(target);
      const targetSnap = await tx.get(targetRef);
      if (!targetSnap.exists) {
        return { kind: 'target_missing' as const, target };
      }

      tx.set(
        roostRef,
        {
          currentManifestId: target,
          previousManifestId: currentId,
          rolledBackAt: FieldValue.serverTimestamp(),
          rolledBackBy: auth.userId,
          rolledBackFrom: currentId,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      return {
        kind: 'ok' as const,
        currentManifestId: target,
        previousManifestId: currentId,
      };
    });

    if (outcome.kind === 'not_found') {
      return problem({
        type: ProblemType.NotFound,
        title: 'not found',
        status: 404,
        detail: `roost ${roostId} not found on site ${site.siteId}`,
        instance: `/api/roosts/${roostId}/rollback`,
      });
    }
    if (outcome.kind === 'no_target') {
      return problem({
        type: ProblemType.Conflict,
        title: 'no rollback target',
        status: 409,
        detail:
          'roost has no previousManifestId and no explicit targetManifestId was provided. ' +
          'nothing to roll back to.',
        instance: `/api/roosts/${roostId}/rollback`,
      });
    }
    if (outcome.kind === 'already_on') {
      return problem({
        type: ProblemType.Conflict,
        title: 'already on target',
        status: 409,
        detail: `roost is already pointed at manifest ${outcome.currentId}`,
        instance: `/api/roosts/${roostId}/rollback`,
      });
    }
    if (outcome.kind === 'target_missing') {
      return problem({
        type: ProblemType.NotFound,
        title: 'target manifest not found',
        status: 404,
        detail: `targetManifestId ${outcome.target} is not in this roost's history`,
        instance: `/api/roosts/${roostId}/rollback`,
      });
    }

    return NextResponse.json({
      currentManifestId: outcome.currentManifestId,
      previousManifestId: outcome.previousManifestId,
    });
  } catch (err) {
    return problemFromError(err, 'v2/roosts/[roostId]/rollback');
  }
}
