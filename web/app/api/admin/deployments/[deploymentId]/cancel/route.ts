import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { apiError } from '@/lib/apiErrorResponse';
import logger from '@/lib/logger';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  authorizedLegacyBodySiteHandler,
  type SiteHandlerContext,
} from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';

const LEGACY_ADMIN_SUNSET = 'Wed, 30 Sep 2026 00:00:00 GMT';

type RouteParams = { deploymentId: string };

/**
 * POST /api/admin/deployments/{deploymentId}/cancel
 *
 * Legacy single-target cancel route. The canonical site route cancels every
 * cancellable target on the deployment; this URL keeps the old machineId
 * contract for compatibility while running through the new auth wrapper.
 */
export const POST = authorizedLegacyBodySiteHandler<RouteParams>({
  capability: Capability.DEPLOYMENT_MANAGE,
  targetKind: 'deployment',
  targetIdParam: 'deploymentId',
  deprecated: true,
  canonicalUrl: '/api/sites/{siteId}/deployments/{deploymentId}/cancel',
  sunsetDate: LEGACY_ADMIN_SUNSET,
  routeName: 'POST /api/admin/deployments/{deploymentId}/cancel',
})(async (request: NextRequest, ctx: SiteHandlerContext, routeContext) => {
  try {
    const deploymentId = await readDeploymentId(request, routeContext.params);
    const body = await request.json();
    const { siteId, machineId, installer_name } = body;

    if (!siteId || !machineId || !installer_name) {
      return NextResponse.json(
        { error: 'Missing required fields: siteId, machineId, installer_name' },
        { status: 400 }
      );
    }

    const db = getAdminDb();
    const deploymentRef = db
      .collection('sites')
      .doc(ctx.siteId)
      .collection('deployments')
      .doc(deploymentId);

    const deploymentSnap = await deploymentRef.get();
    if (!deploymentSnap.exists) {
      return NextResponse.json({ error: 'Deployment not found' }, { status: 404 });
    }

    const deployment = deploymentSnap.data() ?? {};
    const targets = Array.isArray(deployment.targets) ? deployment.targets : [];
    const targetIndex = targets.findIndex((target) => target?.machineId === machineId);
    if (targetIndex < 0) {
      return NextResponse.json(
        { error: `Machine ${machineId} is not a target of this deployment` },
        { status: 400 },
      );
    }

    const existingStatus = targets[targetIndex]?.status;
    if (isTerminalStatus(existingStatus)) {
      return NextResponse.json(
        { error: `Cannot cancel target in ${existingStatus} state` },
        { status: 409 },
      );
    }

    const commandId = `cancel_${Date.now()}_${machineId.replace(/-/g, '_')}`;
    await db
      .collection('sites')
      .doc(ctx.siteId)
      .collection('machines')
      .doc(machineId)
      .collection('commands')
      .doc('pending')
      .set(
        {
          [commandId]: {
            type: 'cancel_installation',
            installer_name,
            deployment_id: deploymentId,
            timestamp: FieldValue.serverTimestamp(),
            status: 'pending',
            auditCorrelationId: ctx.correlationId,
          },
        },
        { merge: true },
      );

    const cancelledTarget = {
      ...targets[targetIndex],
      status: 'cancelled',
      cancelledAt: FieldValue.serverTimestamp(),
    };
    const nextTargets = targets.map((target, index) => (
      index === targetIndex ? cancelledTarget : target
    ));
    const updateData: Record<string, unknown> = { targets: nextTargets };
    if (nextTargets.every((target) => isTerminalStatus(target?.status))) {
      updateData.status = nextTargets.every((target) => target?.status === 'cancelled')
        ? 'cancelled'
        : 'partial';
      updateData.completedAt = FieldValue.serverTimestamp();
    }
    await deploymentRef.update(updateData);

    logger.info(`Deployment ${deploymentId} cancel sent to ${machineId}`, {
      context: 'admin/deployments',
    });

    return NextResponse.json({ success: true, commandId });
  } catch (error: unknown) {
    return apiError(error, 'admin/deployments/[id]/cancel');
  }
});

function isTerminalStatus(status: unknown): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'failed';
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
