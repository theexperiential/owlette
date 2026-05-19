/**
 * cancelDeployment action core (security-boundary-migration wave 3.3).
 *
 * Extracted from
 * `web/app/api/sites/[siteId]/deployments/[deploymentId]/cancel/route.ts`.
 * The HTTP route remains responsible for auth, idempotency, and RFC 7807
 * mapping; this core owns the Firestore mutation sequence.
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { fanOutToMachines } from '@/lib/fanOut.server';
import { emitMutation } from '@/lib/auditLogClient';
import logger from '@/lib/logger';

export const PRE_FLIGHT_DEPLOYMENT_STATUSES = new Set<string>([
  'pending',
  'closing_processes',
  'downloading',
]);

export const TERMINAL_DEPLOYMENT_STATUSES = new Set<string>([
  'completed',
  'failed',
  'cancelled',
  'uninstalled',
]);

interface DeploymentTargetData {
  machineId: string;
  status: string;
  [key: string]: unknown;
}

export interface CancelDeploymentContext {
  siteId: string;
  deploymentId: string;
  /** `user:<uid>` or `apiKey:<keyId>` for audit-log mutation events. */
  actorIdentifier: string;
  /** Opaque correlation id from authorizedSiteHandler. */
  correlationId: string;
  db?: ReturnType<typeof getAdminDb>;
  now?: () => number;
}

export type CancelDeploymentResult =
  | {
      ok: true;
      deploymentId: string;
      siteId: string;
      status: string;
      cancelled: number;
      machine_ids: string[];
    }
  | {
      ok: false;
      code: 'not_found' | 'no_cancellable_targets';
      message: string;
    };

export async function cancelDeployment(
  ctx: CancelDeploymentContext,
): Promise<CancelDeploymentResult> {
  const db = ctx.db ?? getAdminDb();
  const now = ctx.now ?? (() => Date.now());

  const deploymentRef = db
    .collection('sites')
    .doc(ctx.siteId)
    .collection('deployments')
    .doc(ctx.deploymentId);
  const snap = await deploymentRef.get();

  if (!snap.exists) {
    return {
      ok: false,
      code: 'not_found',
      message: `deployment ${ctx.deploymentId} not found on site ${ctx.siteId}`,
    };
  }

  const data = snap.data() ?? {};
  const targets: DeploymentTargetData[] = Array.isArray(data.targets)
    ? (data.targets as DeploymentTargetData[])
    : [];
  const cancellable = targets.filter((target) =>
    PRE_FLIGHT_DEPLOYMENT_STATUSES.has(target.status),
  );

  if (cancellable.length === 0) {
    return {
      ok: false,
      code: 'no_cancellable_targets',
      message: 'every target is already past the queued phase or terminal',
    };
  }

  await Promise.all(
    cancellable.map(async (target) => {
      const pendingRef = db
        .collection('sites')
        .doc(ctx.siteId)
        .collection('machines')
        .doc(target.machineId)
        .collection('commands')
        .doc('pending');
      const pendingSnap = await pendingRef.get();
      if (!pendingSnap.exists) return;
      const queued = pendingSnap.data() ?? {};
      const updates: Record<string, unknown> = {};
      for (const [cmdId, payload] of Object.entries(queued)) {
        if (
          payload &&
          typeof payload === 'object' &&
          (payload as Record<string, unknown>).deployment_id === ctx.deploymentId &&
          (payload as Record<string, unknown>).type === 'install_software'
        ) {
          updates[cmdId] = FieldValue.delete();
        }
      }
      if (Object.keys(updates).length > 0) {
        await pendingRef.update(updates);
      }
    }),
  );

  const installerName =
    typeof data.installer_name === 'string' ? data.installer_name : '';
  const cancelResults = await fanOutToMachines({
    siteId: ctx.siteId,
    machineIds: cancellable.map((target) => target.machineId),
    correlationId: ctx.correlationId,
    db,
    now,
    builder: () => ({
      commandIdPrefix: `cancel_${now()}`,
      commandData: {
        type: 'cancel_installation',
        installer_name: installerName,
        deployment_id: ctx.deploymentId,
        timestamp: FieldValue.serverTimestamp(),
      },
    }),
  });
  const failedCancel = cancelResults.find((result) => !result.ok);
  if (failedCancel) {
    throw new Error(
      `failed to fan out cancel_installation command to ${failedCancel.machineId}: ${failedCancel.error ?? 'unknown error'}`,
    );
  }

  const cancelledAt = Timestamp.fromMillis(now());
  const cancelledMachineIds = new Set(cancellable.map((target) => target.machineId));
  const updatedTargets = targets.map((target) => {
    if (!cancelledMachineIds.has(target.machineId)) return target;
    return {
      ...target,
      status: 'cancelled',
      cancelledAt,
    };
  });

  const allTerminal = updatedTargets.every((target) =>
    TERMINAL_DEPLOYMENT_STATUSES.has(target.status),
  );

  const updatePayload: Record<string, unknown> = {
    targets: updatedTargets,
    updatedAt: FieldValue.serverTimestamp(),
  };
  let responseStatus = 'in_progress';
  if (allTerminal) {
    const statuses = new Set(updatedTargets.map((target) => target.status));
    if (statuses.size === 1 && statuses.has('cancelled')) {
      responseStatus = 'cancelled';
    } else if (statuses.size === 1 && statuses.has('completed')) {
      responseStatus = 'completed';
    } else if (statuses.has('failed') && !statuses.has('completed')) {
      responseStatus = 'failed';
    } else {
      responseStatus = 'partial';
    }
    updatePayload.status = responseStatus;
    updatePayload.completedAt = FieldValue.serverTimestamp();
  }

  await deploymentRef.update(updatePayload);

  try {
    emitMutation({
      kind: 'deployment_mutated',
      siteId: ctx.siteId,
      actor: ctx.actorIdentifier,
      targetId: ctx.deploymentId,
      attributes: {
        endpoint: `/api/sites/${ctx.siteId}/deployments/${ctx.deploymentId}/cancel`,
        method: 'POST',
        verb: 'cancel',
        cancelled_count: cancellable.length,
        machine_ids: cancellable.map((target) => target.machineId),
        correlationId: ctx.correlationId,
      },
    });
  } catch (err) {
    logger.warn('[cancelDeployment] mutation emit threw synchronously', {
      context: 'cancelDeployment',
      data: { err: err instanceof Error ? err.message : String(err) },
    });
  }

  return {
    ok: true,
    deploymentId: ctx.deploymentId,
    siteId: ctx.siteId,
    status: responseStatus,
    cancelled: cancellable.length,
    machine_ids: cancellable.map((target) => target.machineId),
  };
}
