import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError } from '@/lib/apiAuth.server';
import { requireAdminWithSiteAccess, getRouteParam } from '@/lib/apiHelpers.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { apiError } from '@/lib/apiErrorResponse';
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

      const deploymentData = deploymentSnap.data()!;

      // Verify machine is a target in this deployment
      const target = (deploymentData.targets || []).find(
        (t: any) => t.machineId === machineId
      );

      if (!target) {
        return NextResponse.json(
          { error: `Machine ${machineId} is not a target of this deployment` },
          { status: 400 }
        );
      }

      // Verify target is in a cancellable state
      const nonCancellableStatuses = ['completed', 'failed', 'cancelled', 'uninstalled'];
      if (nonCancellableStatuses.includes(target.status)) {
        return NextResponse.json(
          { error: `Cannot cancel target in "${target.status}" state` },
          { status: 409 }
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
          timestamp: FieldValue.serverTimestamp(),
        },
      }, { merge: true });
      const now = Timestamp.now();
      const updatedTargets = (deploymentData.targets || []).map((target: any) => {
        if (target.machineId === machineId) {
          return {
            ...target,
            status: 'cancelled',
            cancelledAt: now,
          };
        }
        return target;
      });

      // Recalculate deployment-level status if all targets are now terminal
      const targetTerminalStatuses = ['completed', 'failed', 'cancelled', 'uninstalled'];
      const allTerminal = updatedTargets.every((t: any) =>
        targetTerminalStatuses.includes(t.status)
      );

      const updatePayload: Record<string, unknown> = {
        targets: updatedTargets,
        updatedAt: FieldValue.serverTimestamp(),
      };

      if (allTerminal) {
        const statuses = new Set(updatedTargets.map((t: any) => t.status));
        if (statuses.size === 1 && statuses.has('cancelled')) {
          updatePayload.status = 'cancelled';
        } else if (statuses.size === 1 && statuses.has('completed')) {
          updatePayload.status = 'completed';
        } else {
          updatePayload.status = 'partial';
        }
        updatePayload.completedAt = FieldValue.serverTimestamp();
      }

      await deploymentRef.update(updatePayload);

      logger.info(`Deployment ${deploymentId} cancelled for machine ${machineId}`, {
        context: 'admin/deployments',
      });

      return NextResponse.json({ success: true, commandId });
    } catch (error: unknown) {
      if (error instanceof ApiAuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      return apiError(error, 'admin/deployments/[id]/cancel');
    }
  },
  { strategy: 'api', identifier: 'ip' }
);
