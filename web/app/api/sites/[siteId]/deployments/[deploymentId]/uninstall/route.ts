/**
 * POST /api/sites/{siteId}/deployments/{deploymentId}/uninstall
 *
 * Queues an `uninstall_software` command for every target machine in the
 * deployment. Flips the deployment-level status to `uninstalling`.
 * Per-target reconciliation lands later — this endpoint does NOT block
 * waiting for completion (track it via GET poll).
 *
 * Requires `site=<id>:admin` and an `Idempotency-Key` header.
 *
 * api-sprint wave 1 — track 1A (installer-deploys-api).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
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

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId, deploymentId } = await params;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    // Per the api-surface spec, uninstall is privileged: requires
    // site=<id>:admin (vs write for create/retry/cancel).
    const auth = await requireSiteAuthAndScope(request, siteId, 'admin');
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
            instance: `/api/sites/${siteId}/deployments/${deploymentId}/uninstall`,
          });
        }

        const data = snap.data() ?? {};
        const targets: DeploymentTarget[] = Array.isArray(data.targets)
          ? (data.targets as DeploymentTarget[])
          : [];

        if (targets.length === 0) {
          return problem({
            type: ProblemType.Conflict,
            title: 'no targets',
            status: 409,
            detail: 'deployment has no target machines to uninstall from',
            instance: `/api/sites/${siteId}/deployments/${deploymentId}/uninstall`,
            code: 'no_targets',
          });
        }

        const installerName =
          typeof data.installer_name === 'string' ? data.installer_name : '';
        if (!installerName) {
          return problem({
            type: ProblemType.Conflict,
            title: 'deployment incomplete',
            status: 409,
            detail: 'deployment record is missing installer_name; cannot uninstall',
            instance: `/api/sites/${siteId}/deployments/${deploymentId}/uninstall`,
          });
        }

        const epoch = Date.now();
        await Promise.all(
          targets.map(async (target) => {
            const sanitizedDeploymentId = deploymentId.replace(/-/g, '_');
            const sanitizedMachineId = target.machineId.replace(/-/g, '_');
            const commandId = `uninstall_${sanitizedDeploymentId}_${sanitizedMachineId}_${epoch}`;

            const pendingRef = db
              .collection('sites')
              .doc(siteId)
              .collection('machines')
              .doc(target.machineId)
              .collection('commands')
              .doc('pending');

            await pendingRef.set(
              {
                [commandId]: {
                  type: 'uninstall_software',
                  installer_name: installerName,
                  deployment_id: deploymentId,
                  timestamp: FieldValue.serverTimestamp(),
                  status: 'pending',
                },
              },
              { merge: true },
            );
          }),
        );

        await deploymentRef.update({
          status: 'uninstalling',
          updatedAt: FieldValue.serverTimestamp(),
        });

        emitMutation({
          kind: 'deployment_mutated',
          siteId,
          actor: auth.auth.keyContext
            ? `apiKey:${auth.auth.keyContext.keyId}`
            : `user:${auth.userId}`,
          targetId: deploymentId,
          attributes: {
            endpoint: `/api/sites/${siteId}/deployments/${deploymentId}/uninstall`,
            method: 'POST',
            verb: 'uninstall',
            target_count: targets.length,
            installer_name: installerName,
          },
        });

        return applyAuthDeprecations(
          NextResponse.json({
            deploymentId,
            siteId,
            status: 'uninstalling',
            queued: targets.length,
            machine_ids: targets.map((t) => t.machineId),
          }),
          auth.scopeCheck,
        );
      },
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/deployments/[deploymentId]/uninstall:POST');
  }
}
