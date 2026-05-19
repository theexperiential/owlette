/**
 * cancelDistribution action core (security-boundary-migration wave 3.4).
 *
 * Mirror of `cancelDeployment` from
 * `web/app/api/sites/[siteId]/deployments/[deploymentId]/cancel/route.ts`.
 *
 * Targets in pre-flight statuses (`pending` / `downloading` / `extracting`)
 * are flipped to `cancelled` and their queued `distribute_project` commands
 * are purged from each machine's `commands/pending` doc. Targets that are
 * `completed` / `failed` / already `cancelled` are left untouched — once
 * the agent has finished a distribution we don't rewrite history, and once
 * a distribution has failed there's nothing to cancel.
 *
 * A `cancel_distribution` command is also fanned out to every cancellable
 * target so the agent — which may be mid-fetch — can short-circuit any
 * in-flight work. This matches the legacy hook behavior.
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { fanOutToMachines } from '@/lib/fanOut.server';
import { emitMutation } from '@/lib/auditLogClient';
import logger from '@/lib/logger';

/** Statuses we'll still try to cancel — anything before "agent confirmed done". */
export const PRE_FLIGHT_DISTRIBUTION_STATUSES = new Set<string>([
  'pending',
  'downloading',
  'extracting',
]);

/** Statuses we treat as terminal for the parent-status recompute. */
export const TERMINAL_DISTRIBUTION_STATUSES = new Set<string>([
  'completed',
  'failed',
  'cancelled',
]);

interface DistributionTargetData {
  machineId: string;
  status: string;
  progress?: number;
  error?: string;
  completedAt?: unknown;
  cancelledAt?: unknown;
}

export interface CancelDistributionContext {
  siteId: string;
  distributionId: string;
  /** Firebase uid of the calling user, or `apiKey:<keyId>` when key-mediated. */
  actorIdentifier: string;
  /** opaque correlation id woven through audit + commands. */
  correlationId: string;
  db?: ReturnType<typeof getAdminDb>;
  now?: () => number;
}

export type CancelDistributionResult =
  | {
      ok: true;
      distributionId: string;
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

/**
 * Cancel pre-flight targets on a distribution. Idempotent: re-running on a
 * distribution where every target is already terminal returns 409
 * `no_cancellable_targets` rather than mutating the parent doc.
 */
export async function cancelDistribution(
  ctx: CancelDistributionContext,
): Promise<CancelDistributionResult> {
  const db = ctx.db ?? getAdminDb();
  const now = ctx.now ?? (() => Date.now());

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
  const targets: DistributionTargetData[] = Array.isArray(data.targets)
    ? (data.targets as DistributionTargetData[])
    : [];
  const cancellable = targets.filter((t) =>
    PRE_FLIGHT_DISTRIBUTION_STATUSES.has(t.status),
  );

  if (cancellable.length === 0) {
    return {
      ok: false,
      code: 'no_cancellable_targets',
      message: 'every target is already past the pre-flight phase or terminal',
    };
  }

  // Purge any queued `distribute_project` commands keyed to this distribution
  // from each cancellable target's pending queue. Without this, the agent
  // could pick up a stale entry between the doc-update and its next poll.
  const fileName = typeof data.file_name === 'string' ? data.file_name : '';
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
          (payload as Record<string, unknown>).distribution_id === ctx.distributionId &&
          (payload as Record<string, unknown>).type === 'distribute_project'
        ) {
          updates[cmdId] = FieldValue.delete();
        }
      }
      if (Object.keys(updates).length > 0) {
        await pendingRef.update(updates);
      }
    }),
  );

  // Fan out `cancel_distribution` so a mid-fetch agent can short-circuit.
  // Mirrors the legacy hook payload (project_name + distribution_id).
  await fanOutToMachines({
    siteId: ctx.siteId,
    machineIds: cancellable.map((t) => t.machineId),
    correlationId: ctx.correlationId,
    db,
    now,
    builder: () => ({
      commandIdPrefix: `cancel_${now()}`,
      commandData: {
        type: 'cancel_distribution',
        project_name: fileName,
        distribution_id: ctx.distributionId,
      },
    }),
  });

  // Mark targets cancelled. Use a wall-clock Timestamp (not serverTimestamp)
  // because Firestore rejects sentinel values inside array elements.
  const cancelledAt = Timestamp.fromMillis(now());
  const cancelledMachineIds = new Set(cancellable.map((t) => t.machineId));
  const updatedTargets = targets.map((target) => {
    if (!cancelledMachineIds.has(target.machineId)) return target;
    return {
      ...target,
      status: 'cancelled',
      cancelledAt,
    };
  });

  // Recompute parent status if every target is now terminal.
  const allTerminal = updatedTargets.every((t) =>
    TERMINAL_DISTRIBUTION_STATUSES.has(t.status),
  );
  const updatePayload: Record<string, unknown> = {
    targets: updatedTargets,
    updatedAt: FieldValue.serverTimestamp(),
  };
  let nextStatus: string =
    typeof data.status === 'string' ? data.status : 'in_progress';
  if (allTerminal) {
    const statuses = new Set(updatedTargets.map((t) => t.status));
    if (statuses.size === 1 && statuses.has('cancelled')) {
      nextStatus = 'cancelled';
    } else if (statuses.size === 1 && statuses.has('completed')) {
      nextStatus = 'completed';
    } else if (statuses.has('failed') && !statuses.has('completed')) {
      nextStatus = 'failed';
    } else {
      nextStatus = 'partial';
    }
    updatePayload.status = nextStatus;
    updatePayload.completedAt = FieldValue.serverTimestamp();
  }

  await distributionRef.update(updatePayload);

  try {
    emitMutation({
      kind: 'distribution_mutated',
      siteId: ctx.siteId,
      actor: ctx.actorIdentifier,
      targetId: ctx.distributionId,
      attributes: {
        endpoint: `/api/sites/${ctx.siteId}/project-distributions/${ctx.distributionId}/cancel`,
        method: 'POST',
        verb: 'cancel',
        cancelled_count: cancellable.length,
        machine_ids: cancellable.map((t) => t.machineId),
        correlationId: ctx.correlationId,
      },
    });
  } catch (err) {
    logger.warn('[cancelDistribution] mutation emit threw synchronously', {
      context: 'cancelDistribution',
      data: { err: err instanceof Error ? err.message : String(err) },
    });
  }

  return {
    ok: true,
    distributionId: ctx.distributionId,
    siteId: ctx.siteId,
    status: nextStatus,
    cancelled: cancellable.length,
    machine_ids: cancellable.map((t) => t.machineId),
  };
}
