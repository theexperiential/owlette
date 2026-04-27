import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';
import logger from '@/lib/logger';
import {
  authorizedSiteHandler,
  type SiteHandlerContext,
} from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import {
  deleteDeployment,
  type DeleteDeploymentResult,
} from '@/lib/actions/deleteDeployment.server';

const LEGACY_ADMIN_SUNSET = 'Wed, 30 Sep 2026 00:00:00 GMT';

type RouteParams = { deploymentId: string };

/**
 * GET /api/admin/deployments/{deploymentId}?siteId=xxx
 *
 * Get full deployment status including all target machine statuses.
 */
export const GET = authorizedSiteHandler<RouteParams>({
  capability: Capability.DEPLOYMENT_MANAGE,
  siteIdParam: 'query',
  targetKind: 'deployment',
  targetIdParam: 'deploymentId',
  apiKeyPermission: 'read',
  deprecated: true,
  canonicalUrl: '/api/sites/{siteId}/deployments/{deploymentId}',
  sunsetDate: LEGACY_ADMIN_SUNSET,
  routeName: 'GET /api/admin/deployments/{deploymentId}',
})(async (request: NextRequest, _ctx: SiteHandlerContext, routeContext) => {
  try {
    const deploymentId = await readDeploymentId(request, routeContext.params);
    const siteId = request.nextUrl.searchParams.get('siteId');

    if (!siteId) {
      return NextResponse.json(
        { error: 'Missing required query param: siteId' },
        { status: 400 }
      );
    }

    const db = getAdminDb();
    const deploymentRef = db.collection('sites').doc(siteId).collection('deployments').doc(deploymentId);
    const deploymentSnap = await deploymentRef.get();

    if (!deploymentSnap.exists) {
      return NextResponse.json(
        { error: 'Deployment not found' },
        { status: 404 }
      );
    }

    const data = deploymentSnap.data()!;

    return NextResponse.json({
      success: true,
      deployment: {
        id: deploymentSnap.id,
        name: data.name || 'Unnamed Deployment',
        installer_name: data.installer_name || '',
        installer_url: data.installer_url || '',
        silent_flags: data.silent_flags || '',
        verify_path: data.verify_path || undefined,
        targets: data.targets || [],
        createdAt: data.createdAt || 0,
        completedAt: data.completedAt || undefined,
        status: data.status || 'pending',
      },
    });
  } catch (error: unknown) {
    return apiError(error, 'admin/deployments/[id] GET');
  }
});

/**
 * DELETE /api/admin/deployments/{deploymentId}?siteId=xxx
 *
 * Delete a deployment record. Only allowed if deployment is in a terminal state.
 */
export const DELETE = authorizedSiteHandler<RouteParams>({
  capability: Capability.DEPLOYMENT_MANAGE,
  siteIdParam: 'query',
  targetKind: 'deployment',
  targetIdParam: 'deploymentId',
  deprecated: true,
  canonicalUrl: '/api/sites/{siteId}/deployments/{deploymentId}',
  sunsetDate: LEGACY_ADMIN_SUNSET,
  routeName: 'DELETE /api/admin/deployments/{deploymentId}',
})(async (_request: NextRequest, ctx: SiteHandlerContext, routeContext) => {
  try {
    const deploymentId = await readDeploymentId(_request, routeContext.params);
    const result = await deleteDeployment({
      siteId: ctx.siteId,
      deploymentId,
      actorIdentifier: actorIdentifier(ctx),
      correlationId: ctx.correlationId,
    });

    if (!result.ok) return deleteDeploymentLegacyError(result);

    logger.info(`Deployment deleted: ${deploymentId}`, { context: 'admin/deployments' });

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    return apiError(error, 'admin/deployments/[id] DELETE');
  }
});

function actorIdentifier(ctx: SiteHandlerContext): string {
  return ctx.auth.keyContext
    ? `apiKey:${ctx.auth.keyContext.keyId}`
    : `user:${ctx.actor.userId}`;
}

async function readDeploymentId(
  request: NextRequest,
  paramsPromise: Promise<RouteParams>,
): Promise<string> {
  const params = await paramsPromise;
  if (params.deploymentId) return params.deploymentId;
  const segments = request.nextUrl.pathname.split('/').filter(Boolean);
  const idx = segments.indexOf('deployments');
  return decodeURIComponent(segments[idx + 1] ?? '');
}

function deleteDeploymentLegacyError(result: Extract<DeleteDeploymentResult, { ok: false }>): NextResponse {
  if (result.code === 'not_found') {
    return NextResponse.json({ error: 'Deployment not found' }, { status: 404 });
  }
  const status = typeof result.details?.status === 'string' ? result.details.status : 'unknown';
  return NextResponse.json(
    { error: `Cannot delete deployment in "${status}" state. Must be terminal.` },
    { status: 409 },
  );
}
