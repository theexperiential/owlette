/**
 * deleteDistribution action core. Mirrors the deployment delete rule: delete
 * only once every target is terminal, so an in-flight distribution must be
 * cancelled first.
 *
 * Queued `distribute_project` commands are NOT cascade-deleted — they carry a
 * 24h `expiresAt` and the agent ignores entries with no live distribution.
 */

import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';
import logger from '@/lib/logger';

/** Terminal statuses that allow a delete — the deployment list minus `uninstalled`. */
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
 * Delete a distribution doc. 409 when the distribution isn't terminal or any
 * target is still pre-flight — the parent status can drift ahead of the
 * targets when the reconciler hasn't run.
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

  // Guards a partial reconciler write: parent terminal, a target missed.
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
