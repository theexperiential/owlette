/**
 * POST /api/sites/{siteId}/deployments/{deploymentId}/retry
 *
 * Re-queues `install_software` commands for every target whose status is
 * `failed`. Targets in any other state (pending, downloading, installing,
 * completed, cancelled, uninstalled) are left untouched. Deployment-level
 * status flips to `in_progress` while at least one retried target hasn't
 * settled, then resolves to `completed` / `partial_failed` / `failed` per
 * the same recompute rules used by cancel.
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
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import { emitMutation } from '@/lib/auditLogClient';
import type { DeploymentTarget } from '@/hooks/useDeployments';

type RouteParams = { siteId: string; deploymentId: string };

export const POST = authorizedSiteHandler<RouteParams>({
  capability: 'DEPLOYMENT_MANAGE',
  siteIdParam: 'path',
  targetKind: 'deployment',
})(async (request: NextRequest, ctx, routeContext) => {
  try {
    const { siteId, deploymentId } = await routeContext.params;

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
            instance: `/api/sites/${siteId}/deployments/${deploymentId}/retry`,
          });
        }

        const data = snap.data() ?? {};
        const targets: DeploymentTarget[] = Array.isArray(data.targets)
          ? (data.targets as DeploymentTarget[])
          : [];
        const failed = targets.filter((t) => t.status === 'failed');

        if (failed.length === 0) {
          return problem({
            type: ProblemType.Conflict,
            title: 'no failed targets',
            status: 409,
            detail: 'no targets in `failed` state to retry',
            instance: `/api/sites/${siteId}/deployments/${deploymentId}/retry`,
            code: 'no_failed_targets',
          });
        }

        const installerUrl = typeof data.installer_url === 'string' ? data.installer_url : '';
        const installerName = typeof data.installer_name === 'string' ? data.installer_name : '';
        const silentFlags = typeof data.silent_flags === 'string' ? data.silent_flags : '';
        const sha256 =
          typeof data.sha256_checksum === 'string' ? data.sha256_checksum : undefined;
        const verifyPath =
          typeof data.verify_path === 'string' ? data.verify_path : undefined;
        const parallelInstall = data.parallel_install === true;

        if (!installerUrl || !installerName) {
          return problem({
            type: ProblemType.Conflict,
            title: 'deployment incomplete',
            status: 409,
            detail: 'deployment record is missing installer_url or installer_name; cannot retry',
            instance: `/api/sites/${siteId}/deployments/${deploymentId}/retry`,
          });
        }

        const retryEpoch = Date.now();

        // Re-queue install_software commands for failed targets only. Other
        // targets are intentionally untouched — see the verbal contract on
        // top of this file.
        await Promise.all(
          failed.map(async (target) => {
            const sanitizedDeploymentId = deploymentId.replace(/-/g, '_');
            const sanitizedMachineId = target.machineId.replace(/-/g, '_');
            const commandId = `install_${sanitizedDeploymentId}_${sanitizedMachineId}_${retryEpoch}`;

            const pendingRef = db
              .collection('sites')
              .doc(siteId)
              .collection('machines')
              .doc(target.machineId)
              .collection('commands')
              .doc('pending');

            const commandData: Record<string, unknown> = {
              type: 'install_software',
              installer_url: installerUrl,
              installer_name: installerName,
              silent_flags: silentFlags,
              deployment_id: deploymentId,
              timestamp: FieldValue.serverTimestamp(),
              status: 'pending',
              retry_attempt: true,
            };
            if (sha256) commandData.sha256_checksum = sha256;
            if (verifyPath) commandData.verify_path = verifyPath;
            if (parallelInstall) commandData.parallel_install = true;

            await pendingRef.set({ [commandId]: commandData }, { merge: true });
          }),
        );

        const retryAt = Timestamp.now();
        // Retried failed targets reset to `pending`. The `error` field is
        // dropped so the UI doesn't show a stale error next to a re-running
        // target; we tag the target with `retriedAt` for audit/debug. We
        // type the row as a generic record because the on-disk shape carries
        // ad-hoc fields (retriedAt, error) that aren't on the strict
        // `DeploymentTarget` union — Firestore writes don't need it.
        const updatedTargets: Array<Record<string, unknown>> = targets.map((target) => {
          if (target.status !== 'failed') return target as unknown as Record<string, unknown>;
          const { error: _droppedError, ...rest } = target;
          void _droppedError;
          return {
            ...rest,
            status: 'pending',
            retriedAt: retryAt,
          };
        });

        await deploymentRef.update({
          targets: updatedTargets,
          status: 'in_progress',
          updatedAt: FieldValue.serverTimestamp(),
          // Clear completedAt — the deployment is back in flight.
          completedAt: FieldValue.delete(),
        });

        emitMutation({
          kind: 'deployment_mutated',
          siteId,
          actor: auth.auth.keyContext
            ? `apiKey:${auth.auth.keyContext.keyId}`
            : `user:${auth.userId}`,
          targetId: deploymentId,
          attributes: {
            endpoint: `/api/sites/${siteId}/deployments/${deploymentId}/retry`,
            method: 'POST',
            verb: 'retry',
            retried_count: failed.length,
            machine_ids: failed.map((t) => t.machineId),
            correlationId: ctx.correlationId,
          },
        });

        return applyAuthDeprecations(
          NextResponse.json({
            deploymentId,
            siteId,
            status: 'in_progress',
            retried: failed.length,
            machine_ids: failed.map((t) => t.machineId),
          }),
          auth.scopeCheck,
        );
      },
      { requireKey: true },
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/deployments/[deploymentId]/retry:POST');
  }
});
