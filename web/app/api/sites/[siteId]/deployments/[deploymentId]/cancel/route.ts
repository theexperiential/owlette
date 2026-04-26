/**
 * POST /api/sites/{siteId}/deployments/{deploymentId}/cancel
 *
 * Marks every target in `pending` (or `closing_processes`/`downloading`)
 * state as `cancelled` and removes their queued `install_software`
 * command from `sites/{siteId}/machines/{machineId}/commands/pending`
 * if it is still there. Targets that are already `installing`,
 * `completed`, `failed`, or `cancelled` are left untouched — once an
 * installer is running on the machine, the agent owns the lifecycle.
 *
 * Requires `site=<id>:write` and an `Idempotency-Key` header.
 *
 * api-sprint wave 1 — track 1A (installer-deploys-api).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { problem, problemFromError, ProblemType } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  applyAuthDeprecations,
  readAndParseJsonBody,
  requireSiteAuthAndScope,
} from '../../../../../_shared';
import { withIdempotency } from '@/lib/idempotency';
import { emitMutation } from '@/lib/auditLogClient';
import type { DeploymentTarget } from '@/hooks/useDeployments';

interface RouteParams {
  params: Promise<{ siteId: string; deploymentId: string }>;
}

/**
 * Statuses we consider "still in the queue, safe to cancel without racing
 * the agent." `installing` is intentionally excluded — once the installer
 * is running we let it run to completion or failure rather than tearing
 * a half-installed binary out from under it.
 */
const PRE_FLIGHT_STATUSES = new Set<DeploymentTarget['status']>([
  'pending',
  'closing_processes',
  'downloading',
]);
const TERMINAL_STATUSES = new Set<DeploymentTarget['status']>([
  'completed',
  'failed',
  'cancelled',
  'uninstalled',
]);

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId, deploymentId } = await params;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    const auth = await requireSiteAuthAndScope(request, siteId, 'write');
    if (!auth.ok) return auth.response;

    return withIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        const db = getAdminDb();
        const deploymentRef = db
          .collection('sites')
          .doc(siteId)
          .collection('deployments')
          .doc(deploymentId);
        const snap = await deploymentRef.get();

        if (!snap.exists) {
          return problem({
            type: ProblemType.NotFound,
            title: 'not found',
            status: 404,
            detail: `deployment ${deploymentId} not found on site ${siteId}`,
            instance: `/api/sites/${siteId}/deployments/${deploymentId}/cancel`,
          });
        }

        const data = snap.data() ?? {};
        const targets: DeploymentTarget[] = Array.isArray(data.targets)
          ? (data.targets as DeploymentTarget[])
          : [];
        const cancellable = targets.filter((t) => PRE_FLIGHT_STATUSES.has(t.status));

        if (cancellable.length === 0) {
          return problem({
            type: ProblemType.Conflict,
            title: 'no cancellable targets',
            status: 409,
            detail: 'every target is already past the queued phase or terminal',
            instance: `/api/sites/${siteId}/deployments/${deploymentId}/cancel`,
            code: 'no_cancellable_targets',
          });
        }

        // Purge the install_software commands from each cancellable
        // target's pending queue. These were keyed by deployment_id when
        // the deploy fanned out, so we read the pending doc, filter out
        // matching keys, and write the survivors back. Fire-and-forget
        // wouldn't be safe — the agent might pick up a stale entry between
        // the doc-update and the next 10s loop.
        await Promise.all(
          cancellable.map(async (target) => {
            const pendingRef = db
              .collection('sites')
              .doc(siteId)
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
                (payload as Record<string, unknown>).deployment_id === deploymentId &&
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

        const cancelledAt = Timestamp.now();
        const cancelledMachineIds = new Set(cancellable.map((t) => t.machineId));
        const updatedTargets: Array<Record<string, unknown>> = targets.map((target) => {
          if (!cancelledMachineIds.has(target.machineId)) {
            return target as unknown as Record<string, unknown>;
          }
          return {
            ...target,
            status: 'cancelled',
            cancelledAt,
          };
        });

        // Recompute deployment-level status if every target is now terminal.
        const allTerminal = updatedTargets.every((t) =>
          TERMINAL_STATUSES.has((t as { status: DeploymentTarget['status'] }).status),
        );

        const updatePayload: Record<string, unknown> = {
          targets: updatedTargets,
          updatedAt: FieldValue.serverTimestamp(),
        };
        if (allTerminal) {
          const statuses = new Set(
            updatedTargets.map((t) => (t as { status: string }).status),
          );
          if (statuses.size === 1 && statuses.has('cancelled')) {
            updatePayload.status = 'cancelled';
          } else if (statuses.size === 1 && statuses.has('completed')) {
            updatePayload.status = 'completed';
          } else if (statuses.has('failed') && !statuses.has('completed')) {
            updatePayload.status = 'failed';
          } else {
            updatePayload.status = 'partial';
          }
          updatePayload.completedAt = FieldValue.serverTimestamp();
        }

        await deploymentRef.update(updatePayload);

        emitMutation({
          kind: 'deployment_mutated',
          siteId,
          actor: auth.auth.keyContext
            ? `apiKey:${auth.auth.keyContext.keyId}`
            : `user:${auth.userId}`,
          targetId: deploymentId,
          attributes: {
            endpoint: `/api/sites/${siteId}/deployments/${deploymentId}/cancel`,
            method: 'POST',
            verb: 'cancel',
            cancelled_count: cancellable.length,
            machine_ids: cancellable.map((t) => t.machineId),
          },
        });

        return applyAuthDeprecations(
          NextResponse.json({
            deploymentId,
            siteId,
            status: typeof updatePayload.status === 'string' ? updatePayload.status : 'in_progress',
            cancelled: cancellable.length,
            machine_ids: cancellable.map((t) => t.machineId),
          }),
          auth.scopeCheck,
        );
      },
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/deployments/[deploymentId]/cancel:POST');
  }
}
