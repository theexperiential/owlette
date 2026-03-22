import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError } from '@/lib/apiAuth.server';
import { requireAdminWithSiteAccess, getRouteParam } from '@/lib/apiHelpers.server';
import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';

/**
 * POST /api/admin/deployments/{deploymentId}/cancel
 *
 * Cancel a deployment for a specific machine. Sends cancel_installation command
 * and updates the target status to 'cancelled'.
 *
 * Request body:
 *   siteId: string
 *   machineId: string
 *   installer_name: string
 */
export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      // /api/admin/deployments/{deploymentId}/cancel → segments: ['api','admin','deployments','{id}','cancel']
      const deploymentId = getRouteParam(request, 3);
      const body = await request.json();
      const { siteId, machineId, installer_name } = body;

      if (!siteId || !machineId || !installer_name) {
        return NextResponse.json(
          { error: 'Missing required fields: siteId, machineId, installer_name' },
          { status: 400 }
        );
      }

      await requireAdminWithSiteAccess(request, siteId);

      const db = getAdminDb();

      // Verify deployment exists
      const deploymentRef = db.collection('sites').doc(siteId).collection('deployments').doc(deploymentId);
      const deploymentSnap = await deploymentRef.get();

      if (!deploymentSnap.exists) {
        return NextResponse.json(
          { error: 'Deployment not found' },
          { status: 404 }
        );
      }

      // Send cancel_installation command (mirrors cancelDeployment in useDeployments.ts)
      const sanitizedMachineId = machineId.replace(/-/g, '_');
      const commandId = `cancel_${Date.now()}_${sanitizedMachineId}`;
      const pendingRef = db
        .collection('sites').doc(siteId)
        .collection('machines').doc(machineId)
        .collection('commands').doc('pending');

      await pendingRef.set({
        [commandId]: {
          type: 'cancel_installation',
          installer_name,
          deployment_id: deploymentId,
          timestamp: Date.now(),
        },
      }, { merge: true });

      // Update target status to 'cancelled' in deployment doc
      const deploymentData = deploymentSnap.data()!;
      const updatedTargets = (deploymentData.targets || []).map((target: any) => {
        if (target.machineId === machineId) {
          return {
            ...target,
            status: 'cancelled',
            cancelledAt: Date.now(),
          };
        }
        return target;
      });

      await deploymentRef.update({
        targets: updatedTargets,
        updatedAt: Date.now(),
      });

      logger.info(`Deployment ${deploymentId} cancelled for machine ${machineId}`, {
        context: 'admin/deployments',
      });

      return NextResponse.json({ success: true, commandId });
    } catch (error: unknown) {
      if (error instanceof ApiAuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      console.error('admin/deployments/cancel POST:', error);
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Internal server error' },
        { status: 500 }
      );
    }
  },
  { strategy: 'user', identifier: 'ip' }
);
