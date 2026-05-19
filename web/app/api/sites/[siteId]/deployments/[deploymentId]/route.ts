/**
 * GET    /api/sites/{siteId}/deployments/{deploymentId}
 *        -> fetch full deployment detail.
 *
 * DELETE /api/sites/{siteId}/deployments/{deploymentId}
 *        -> delete a terminal deployment doc.
 *
 * security-boundary-migration wave 3.3: delete logic lives in
 * `web/lib/actions/deleteDeployment.server.ts`.
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
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import {
  deleteDeployment,
  type DeleteDeploymentResult,
} from '@/lib/actions/deleteDeployment.server';

type RouteParams = { siteId: string; deploymentId: string };

/* --------------------------------------------------------------------- */
/*  GET - deployment detail                                               */
/* --------------------------------------------------------------------- */

export const GET = authorizedSiteHandler<RouteParams>({
  capability: 'DEPLOYMENT_MANAGE',
  siteIdParam: 'path',
  targetKind: 'deployment',
  apiKeyPermission: 'read',
})(async (request: NextRequest, _ctx, routeContext) => {
  try {
    const { siteId, deploymentId } = await routeContext.params;
    const auth = await requireSiteAuthAndScope(request, siteId, 'read');
    if (!auth.ok) return auth.response;

    const db = getAdminDb();
    const deploymentRef = db
      .collection('sites')
      .doc(siteId)
      .collection('deployments')
      .doc(deploymentId);
    const snap = await deploymentRef.get();

    if (!snap.exists) {
      return problem({
        type: ProblemType.NotFound,
        title: 'not found',
        status: 404,
        detail: `deployment ${deploymentId} not found on site ${siteId}`,
        instance: `/api/sites/${siteId}/deployments/${deploymentId}`,
      });
    }

    const data = snap.data() ?? {};

    return applyAuthDeprecations(
      NextResponse.json({
        id: snap.id,
        siteId,
        name: typeof data.name === 'string' ? data.name : 'Unnamed Deployment',
        installer_name: typeof data.installer_name === 'string' ? data.installer_name : '',
        installer_url: typeof data.installer_url === 'string' ? data.installer_url : '',
        silent_flags: typeof data.silent_flags === 'string' ? data.silent_flags : '',
        verify_path: typeof data.verify_path === 'string' ? data.verify_path : null,
        sha256_checksum: typeof data.sha256_checksum === 'string' ? data.sha256_checksum : null,
        parallel_install: data.parallel_install === true,
        targets: Array.isArray(data.targets) ? data.targets : [],
        status: typeof data.status === 'string' ? data.status : 'pending',
        createdAt: timestampToIso(data.createdAt),
        completedAt: timestampToIso(data.completedAt),
        updatedAt: timestampToIso(data.updatedAt),
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/deployments/[deploymentId]:GET');
  }
});

/* --------------------------------------------------------------------- */
/*  DELETE - terminal-only delete                                         */
/* --------------------------------------------------------------------- */

export const DELETE = authorizedSiteHandler<RouteParams>({
  capability: 'DEPLOYMENT_MANAGE',
  siteIdParam: 'path',
  targetKind: 'deployment',
})(async (request: NextRequest, ctx, routeContext) => {
  try {
    const { siteId, deploymentId } = await routeContext.params;

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
        const result = await deleteDeployment({
          siteId,
          deploymentId,
          actorIdentifier: actorIdentifier(auth),
          correlationId: ctx.correlationId,
        });

        if (!result.ok) {
          return deleteDeploymentErrorToResponse(result, siteId, deploymentId);
        }

        return applyAuthDeprecations(
          NextResponse.json({
            deploymentId: result.deploymentId,
            siteId: result.siteId,
            deleted: true,
          }),
          auth.scopeCheck,
        );
      },
      { requireKey: true },
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/deployments/[deploymentId]:DELETE');
  }
});

/* --------------------------------------------------------------------- */
/*  helpers                                                               */
/* --------------------------------------------------------------------- */

function actorIdentifier(auth: Extract<Awaited<ReturnType<typeof requireSiteAuthAndScope>>, { ok: true }>): string {
  return auth.auth.keyContext
    ? `apiKey:${auth.auth.keyContext.keyId}`
    : `user:${auth.userId}`;
}

function deleteDeploymentErrorToResponse(
  result: Extract<DeleteDeploymentResult, { ok: false }>,
  siteId: string,
  deploymentId: string,
): NextResponse {
  if (result.code === 'not_found') {
    return problem({
      type: ProblemType.NotFound,
      title: 'not found',
      status: 404,
      detail: result.message,
      instance: `/api/sites/${siteId}/deployments/${deploymentId}`,
    });
  }

  return problem({
    type: ProblemType.Conflict,
    title: 'deployment in flight',
    status: 409,
    detail: result.message,
    instance: `/api/sites/${siteId}/deployments/${deploymentId}`,
    code: 'deployment_in_flight',
    ...problemSafeDetails(result.details),
  });
}

function problemSafeDetails(details: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!details) return {};
  const { status, ...rest } = details;
  return status === undefined ? rest : { ...rest, deployment_status: status };
}
