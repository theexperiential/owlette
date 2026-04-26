/**
 * deleteDeployment action core (security-boundary-migration wave 3.3).
 *
 * Deletes only terminal deployment docs. This mirrors the legacy admin
 * deployment delete guard and adds a target-level in-flight check so a stale
 * parent status cannot hide a still-running install.
 */

import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';
import logger from '@/lib/logger';

export const TERMINAL_DEPLOYMENT_STATUSES_FOR_DELETE = new Set<string>([
  'completed',
  'failed',
  'partial',
  'cancelled',
  'uninstalled',
]);

const IN_FLIGHT_TARGET_STATUSES = new Set<string>([
  'pending',
  'closing_processes',
  'downloading',
  'installing',
]);

interface DeploymentTargetData {
  machineId: string;
  status: string;
}

export interface DeleteDeploymentContext {
  siteId: string;
  deploymentId: string;
  /** `user:<uid>` or `apiKey:<keyId>` for audit-log mutation events. */
  actorIdentifier: string;
  /** Opaque correlation id from authorizedSiteHandler. */
  correlationId: string;
  db?: ReturnType<typeof getAdminDb>;
}

export type DeleteDeploymentResult =
  | {
      ok: true;
      deploymentId: string;
      siteId: string;
    }
  | {
      ok: false;
      code: 'not_found' | 'deployment_in_flight';
      message: string;
      details?: Record<string, unknown>;
    };

export async function deleteDeployment(
  ctx: DeleteDeploymentContext,
): Promise<DeleteDeploymentResult> {
  const db = ctx.db ?? getAdminDb();

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
  const status = typeof data.status === 'string' ? data.status : 'unknown';
  if (!TERMINAL_DEPLOYMENT_STATUSES_FOR_DELETE.has(status)) {
    return {
      ok: false,
      code: 'deployment_in_flight',
      message: `cannot delete deployment in '${status}' state; cancel first or wait for completion`,
      details: {
        status,
        terminal_states: [...TERMINAL_DEPLOYMENT_STATUSES_FOR_DELETE],
      },
    };
  }

  const targets: DeploymentTargetData[] = Array.isArray(data.targets)
    ? (data.targets as DeploymentTargetData[])
    : [];
  const stillInFlight = targets.find((target) =>
    IN_FLIGHT_TARGET_STATUSES.has(target.status),
  );
  if (stillInFlight) {
    return {
      ok: false,
      code: 'deployment_in_flight',
      message: `cannot delete: target ${stillInFlight.machineId} is still '${stillInFlight.status}'`,
      details: {
        status,
        target_status: stillInFlight.status,
        target_machine_id: stillInFlight.machineId,
      },
    };
  }

  await deploymentRef.delete();

  try {
    emitMutation({
      kind: 'deployment_mutated',
      siteId: ctx.siteId,
      actor: ctx.actorIdentifier,
      targetId: ctx.deploymentId,
      attributes: {
        endpoint: `/api/sites/${ctx.siteId}/deployments/${ctx.deploymentId}`,
        method: 'DELETE',
        verb: 'delete',
        prior_status: status,
        correlationId: ctx.correlationId,
      },
    });
  } catch (err) {
    logger.warn('[deleteDeployment] mutation emit threw synchronously', {
      context: 'deleteDeployment',
      data: { err: err instanceof Error ? err.message : String(err) },
    });
  }

  return {
    ok: true,
    deploymentId: ctx.deploymentId,
    siteId: ctx.siteId,
  };
}
