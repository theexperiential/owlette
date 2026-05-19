/**
 * deleteDistribution action core (security-boundary-migration wave 3.4).
 *
 * Mirrors the deployment delete rule: only delete when every target has
 * reached a terminal state. In-flight distributions cannot be deleted, so
 * the operator must cancel them first.
 *
 * The action does NOT cascade-delete queued `distribute_project` commands
 * from machine pending docs. Commands have a 24h `expiresAt` and the agent
 * ignores entries it can't resolve to a live distribution. Cleanup is wave
 * 8.x housekeeping.
 */

import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';
import logger from '@/lib/logger';

/**
 * Distribution-level statuses that allow a delete. Matches the deployment
 * terminal list, minus `uninstalled` (distributions don't have an uninstall
 * path).
 */
export const TERMINAL_DISTRIBUTION_STATUSES_FOR_DELETE = new Set<string>([
  'completed',
  'failed',
  'partial',
  'cancelled',
]);

interface DistributionTargetData {
  machineId: string;
  status: string;
}

export interface DeleteDistributionContext {
  siteId: string;
  distributionId: string;
  /** Firebase uid of the calling user, or `apiKey:<keyId>` when key-mediated. */
  actorIdentifier: string;
  /** opaque correlation id woven through audit. */
  correlationId: string;
  db?: ReturnType<typeof getAdminDb>;
}

export type DeleteDistributionResult =
  | {
      ok: true;
      distributionId: string;
      siteId: string;
    }
  | {
      ok: false;
      code: 'not_found' | 'distribution_in_flight';
      message: string;
      details?: Record<string, unknown>;
    };

/**
 * Delete a distribution doc. Refuses with 409 if the distribution is not
 * in a terminal state OR if any target is still pre-flight (this is a
 * defense-in-depth check on top of the parent-status guard, since the
 * status field can drift if the reconciler hasn't run yet).
 */
export async function deleteDistribution(
  ctx: DeleteDistributionContext,
): Promise<DeleteDistributionResult> {
  const db = ctx.db ?? getAdminDb();

  const distributionRef = db
    .collection('sites')
    .doc(ctx.siteId)
    .collection('project_distributions')
    .doc(ctx.distributionId);
  const snap = await distributionRef.get();

  if (!snap.exists) {
    return {
      ok: false,
      code: 'not_found',
      message: `distribution ${ctx.distributionId} not found on site ${ctx.siteId}`,
    };
  }

  const data = snap.data() ?? {};
  const status = typeof data.status === 'string' ? data.status : 'unknown';
  if (!TERMINAL_DISTRIBUTION_STATUSES_FOR_DELETE.has(status)) {
    return {
      ok: false,
      code: 'distribution_in_flight',
      message: `cannot delete distribution in '${status}' state; cancel first or wait for completion`,
      details: {
        status,
        terminal_states: [...TERMINAL_DISTRIBUTION_STATUSES_FOR_DELETE],
      },
    };
  }

  // Defense in depth: even if parent status looks terminal, refuse if any
  // target is still in a pre-flight state. This shields against a partial
  // reconciler write where the parent status was updated but a target was
  // missed.
  const targets: DistributionTargetData[] = Array.isArray(data.targets)
    ? (data.targets as DistributionTargetData[])
    : [];
  const stillInFlight = targets.find(
    (t) => t.status === 'pending' || t.status === 'downloading' || t.status === 'extracting',
  );
  if (stillInFlight) {
    return {
      ok: false,
      code: 'distribution_in_flight',
      message: `cannot delete: target ${stillInFlight.machineId} is still '${stillInFlight.status}'`,
      details: {
        status,
        target_status: stillInFlight.status,
        target_machine_id: stillInFlight.machineId,
      },
    };
  }

  await distributionRef.delete();

  try {
    emitMutation({
      kind: 'distribution_mutated',
      siteId: ctx.siteId,
      actor: ctx.actorIdentifier,
      targetId: ctx.distributionId,
      attributes: {
        endpoint: `/api/sites/${ctx.siteId}/project-distributions/${ctx.distributionId}`,
        method: 'DELETE',
        verb: 'delete',
        prior_status: status,
        correlationId: ctx.correlationId,
      },
    });
  } catch (err) {
    logger.warn('[deleteDistribution] mutation emit threw synchronously', {
      context: 'deleteDistribution',
      data: { err: err instanceof Error ? err.message : String(err) },
    });
  }

  return {
    ok: true,
    distributionId: ctx.distributionId,
    siteId: ctx.siteId,
  };
}
