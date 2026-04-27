import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';
import logger from '@/lib/logger';
import {
  authorizedLegacyBodySiteHandler,
  authorizedSiteHandler,
  type SiteHandlerContext,
} from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import {
  createDeployment,
  type CreateDeploymentInput,
  type CreateDeploymentResult,
} from '@/lib/actions/createDeployment.server';

const LEGACY_ADMIN_SUNSET = 'Wed, 30 Sep 2026 00:00:00 GMT';

/**
 * GET /api/admin/deployments?siteId=xxx&limit=20
 *
 * List deployments for a site, ordered by creation date (newest first).
 */
export const GET = authorizedSiteHandler({
  capability: Capability.DEPLOYMENT_MANAGE,
  siteIdParam: 'query',
  targetKind: 'deployment',
  apiKeyPermission: 'read',
  deprecated: true,
  canonicalUrl: '/api/sites/{siteId}/deployments',
  sunsetDate: LEGACY_ADMIN_SUNSET,
  routeName: 'GET /api/admin/deployments',
})(async (request: NextRequest) => {
  try {
    const siteId = request.nextUrl.searchParams.get('siteId');
    if (!siteId) {
      return NextResponse.json(
        { error: 'Missing required query param: siteId' },
        { status: 400 }
      );
    }

    const limitParam = request.nextUrl.searchParams.get('limit');
    const queryLimit = Math.min(Math.max(parseInt(limitParam || '20', 10) || 20, 1), 100);

    const db = getAdminDb();
    const deploymentsRef = db.collection('sites').doc(siteId).collection('deployments');
    const snapshot = await deploymentsRef
      .orderBy('createdAt', 'desc')
      .limit(queryLimit)
      .get();

    const deployments = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        name: data.name || 'Unnamed Deployment',
        installer_name: data.installer_name || '',
        installer_url: data.installer_url || '',
        silent_flags: data.silent_flags || '',
        verify_path: data.verify_path || undefined,
        targets: data.targets || [],
        createdAt: data.createdAt || 0,
        completedAt: data.completedAt || undefined,
        status: data.status || 'pending',
      };
    });

    return NextResponse.json({ success: true, deployments });
  } catch (error: unknown) {
    return apiError(error, 'admin/deployments GET');
  }
});

/**
 * POST /api/admin/deployments
 *
 * Legacy body-scoped create route. Delegates to the canonical deployment
 * action core used by `/api/sites/{siteId}/deployments`.
 */
export const POST = authorizedLegacyBodySiteHandler({
  capability: Capability.DEPLOYMENT_MANAGE,
  targetKind: 'deployment',
  deprecated: true,
  canonicalUrl: '/api/sites/{siteId}/deployments',
  sunsetDate: LEGACY_ADMIN_SUNSET,
  routeName: 'POST /api/admin/deployments',
})(async (request: NextRequest, ctx: SiteHandlerContext) => {
  try {
    const body = await request.json();
    const {
      siteId,
      name,
      installer_name,
      installer_url,
      silent_flags,
      sha256_checksum,
      verify_path,
      close_processes,
      suppress_projects,
      parallel_install,
      machineIds,
    } = body;

    if (!siteId || !name || !installer_name || !installer_url || silent_flags === undefined) {
      return NextResponse.json(
        { error: 'Missing required fields: siteId, name, installer_name, installer_url, silent_flags' },
        { status: 400 }
      );
    }

    if (!machineIds || !Array.isArray(machineIds) || machineIds.length === 0) {
      return NextResponse.json(
        { error: 'machineIds must be a non-empty array' },
        { status: 400 }
      );
    }

    const input: CreateDeploymentInput = {
      name,
      installer_name,
      installer_url,
      silent_flags,
      machines: machineIds,
      ...(sha256_checksum ? { sha256_checksum } : {}),
      ...(verify_path ? { verify_path } : {}),
      ...(Array.isArray(close_processes) ? { close_processes } : {}),
      ...(Array.isArray(suppress_projects) ? { suppress_projects } : {}),
      ...(parallel_install ? { parallel_install: true } : {}),
    };

    const result = await createDeployment(input, {
      siteId: ctx.siteId,
      createdBy: ctx.actor.userId,
      actorIdentifier: actorIdentifier(ctx),
      correlationId: ctx.correlationId,
    });

    if (!result.ok) return createDeploymentLegacyError(result);

    logger.info(`Deployment created: ${result.deploymentId} targeting ${machineIds.length} machines`, {
      context: 'admin/deployments',
    });

    return NextResponse.json({ success: true, deploymentId: result.deploymentId });
  } catch (error: unknown) {
    return apiError(error, 'admin/deployments POST');
  }
});

function actorIdentifier(ctx: SiteHandlerContext): string {
  return ctx.auth.keyContext
    ? `apiKey:${ctx.auth.keyContext.keyId}`
    : `user:${ctx.actor.userId}`;
}

function createDeploymentLegacyError(result: Extract<CreateDeploymentResult, { ok: false }>): NextResponse {
  const status = result.code === 'over_quota' ? 413 : 400;
  return NextResponse.json({ error: result.message }, { status });
}
