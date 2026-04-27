/**
 * GET    /api/sites/{siteId}/project-distributions/{distId}
 *        → fetch full distribution detail incl. per-target status array.
 *          Requires `site=<id>:read`.
 *
 * DELETE /api/sites/{siteId}/project-distributions/{distId}
 *        → delete a distribution doc. Refuses 409 unless the distribution
 *          is in a terminal state and no target is still pre-flight.
 *          Requires `site=<id>:write` and an `Idempotency-Key` header.
 *
 * Mirror of `/api/sites/{siteId}/deployments/{deploymentId}`, specialised
 * for the project-distribution surface (security-boundary-migration wave 3.4).
 * Action core: `web/lib/actions/deleteDistribution.server.ts`.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problem, problemFromError, ProblemType } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { timestampToIso } from '@/lib/firestoreTime.server';
import {
  applyAuthDeprecations,
  readAndParseJsonBody,
  requireSiteAuthAndScope,
} from '../../../../_shared';
import { withIdempotency } from '@/lib/idempotency';
import { generateCorrelationId } from '@/lib/auditLog.server';
import { deleteDistribution } from '@/lib/actions/deleteDistribution.server';

interface RouteParams {
  params: Promise<{ siteId: string; distId: string }>;
}

/* --------------------------------------------------------------------- */
/*  GET — distribution detail                                            */
/* --------------------------------------------------------------------- */

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId, distId } = await params;
    const auth = await requireSiteAuthAndScope(request, siteId, 'read');
    if (!auth.ok) return auth.response;

    const db = getAdminDb();
    const distributionRef = db
      .collection('sites')
      .doc(siteId)
      .collection('project_distributions')
      .doc(distId);
    const snap = await distributionRef.get();

    if (!snap.exists) {
      return problem({
        type: ProblemType.NotFound,
        title: 'not found',
        status: 404,
        detail: `distribution ${distId} not found on site ${siteId}`,
        instance: `/api/sites/${siteId}/project-distributions/${distId}`,
      });
    }

    const data = snap.data() ?? {};

    return applyAuthDeprecations(
      NextResponse.json({
        id: snap.id,
        siteId,
        name: typeof data.name === 'string' ? data.name : 'Unnamed Distribution',
        file_name: typeof data.file_name === 'string' ? data.file_name : '',
        project_url: typeof data.project_url === 'string' ? data.project_url : '',
        extract_path: typeof data.extract_path === 'string' ? data.extract_path : null,
        verify_files: Array.isArray(data.verify_files) ? data.verify_files : null,
        targets: Array.isArray(data.targets) ? data.targets : [],
        status: typeof data.status === 'string' ? data.status : 'pending',
        createdAt: timestampToIso(data.createdAt),
        completedAt: timestampToIso(data.completedAt),
        updatedAt: timestampToIso(data.updatedAt),
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/project-distributions/[distId]:GET');
  }
}

/* --------------------------------------------------------------------- */
/*  DELETE — terminal-only delete                                        */
/* --------------------------------------------------------------------- */

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId, distId } = await params;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    const auth = await requireSiteAuthAndScope(request, siteId, 'write');
    if (!auth.ok) return auth.response;

    return withIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        const correlationId = generateCorrelationId();
        const actorIdentifier = auth.auth.keyContext
          ? `apiKey:${auth.auth.keyContext.keyId}`
          : `user:${auth.userId}`;

        const result = await deleteDistribution({
          siteId,
          distributionId: distId,
          actorIdentifier,
          correlationId,
        });

        if (!result.ok) {
          if (result.code === 'not_found') {
            return problem({
              type: ProblemType.NotFound,
              title: 'not found',
              status: 404,
              detail: result.message,
              instance: `/api/sites/${siteId}/project-distributions/${distId}`,
            });
          }
          // 'distribution_in_flight'
          return problem({
            type: ProblemType.Conflict,
            title: 'distribution in flight',
            status: 409,
            detail: result.message,
            instance: `/api/sites/${siteId}/project-distributions/${distId}`,
            code: 'distribution_in_flight',
            ...(result.details ?? {}),
          });
        }

        return applyAuthDeprecations(
          NextResponse.json({
            distributionId: result.distributionId,
            siteId: result.siteId,
            deleted: true,
          }),
          auth.scopeCheck,
        );
      },
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/project-distributions/[distId]:DELETE');
  }
}
