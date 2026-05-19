/**
 * Deployment-status reconciler cloud function
 * (security-boundary-migration wave 2.4).
 *
 * Triggers on every write to a machine's pending-commands map doc:
 *
 *   sites/{siteId}/machines/{machineId}/commands/pending
 *
 * The dashboard used to listen to per-machine command events and
 * mutate the parent deployment doc client-side (in `useDeployments`).
 * After security-boundary lockdown the dashboard cannot write to
 * deployment docs anymore — the cloud function takes over.
 *
 * Per-trigger flow:
 *   1. Diff the before/after map shape, find commands whose `status`,
 *      `progress`, or `auditCorrelationId` changed.
 *   2. Bucket changed commands by `deployment_id`.
 *   3. For each bucket, load the parent deployment doc and feed
 *      (deployment, machineId, commands) into `reconcileDeployment`.
 *   4. If the verdict is `apply`, write the new `targets[]` + status
 *      with admin sdk and append a system-actor audit entry whose
 *      `correlationId` mirrors the command's own `auditCorrelationId`.
 *   5. If the verdict is `skip` (idempotency, machine not targeted,
 *      etc.), do nothing — no write, no audit row.
 *
 * Idempotency: each command entry carries an `auditCorrelationId`
 * minted by the wave-2.1 `authorizedHandler` at command-creation time.
 * The reconciler stamps that id onto the matching target as
 * `lastProcessedCommandCorrelationId`. A duplicate trigger firing for
 * the same command sees the id already on the target and bails before
 * writing.
 */

import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import {
  diffCommandMap,
  groupByDeploymentId,
  reconcileDeployment,
  type ChangedCommand,
  type DeploymentTarget,
} from './lib/reconcilerLogic';
import { writeReconcilerAuditEntry } from './lib/reconcilerAudit';

const db = () => admin.firestore();

export const reconcileDeploymentStatus = onDocumentUpdated(
  'sites/{siteId}/machines/{machineId}/commands/pending',
  async (event) => {
    const { siteId, machineId } = event.params as {
      siteId: string;
      machineId: string;
    };

    const beforeData =
      (event.data?.before?.data() as Record<string, unknown> | undefined) ?? {};
    const afterData =
      (event.data?.after?.data() as Record<string, unknown> | undefined) ?? {};

    const changed = diffCommandMap(beforeData, afterData);
    if (changed.length === 0) return;

    const groups = groupByDeploymentId(changed);
    if (groups.size === 0) return;

    await Promise.all(
      Array.from(groups.entries()).map(([deploymentId, commands]) =>
        reconcileOne(siteId, machineId, deploymentId, commands),
      ),
    );
  },
);

async function reconcileOne(
  siteId: string,
  machineId: string,
  deploymentId: string,
  commands: ChangedCommand[],
): Promise<void> {
  const deploymentRef = db()
    .collection('sites')
    .doc(siteId)
    .collection('deployments')
    .doc(deploymentId);

  const snap = await deploymentRef.get();
  if (!snap.exists) {
    console.warn(
      `[reconcileDeployment] deployment ${deploymentId} not found ` +
        `(site=${siteId} machine=${machineId}); skipping.`,
    );
    return;
  }

  const data = snap.data() as
    | { status?: string; targets?: DeploymentTarget[] }
    | undefined;
  const previousStatus = data?.status;

  const verdict = reconcileDeployment({
    deployment: data ?? {},
    commands,
    machineId,
  });

  if (verdict.kind === 'skip') {
    if (verdict.reason === 'already_processed') {
      console.log(
        `[reconcileDeployment] skip duplicate (site=${siteId} ` +
          `deployment=${deploymentId} machine=${machineId})`,
      );
    }
    return;
  }

  const updatedTarget = verdict.targets[verdict.targetIndex];
  const updatePayload: Record<string, unknown> = {
    targets: verdict.targets,
    status: verdict.status,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (verdict.becameTerminal) {
    updatePayload.completedAt = FieldValue.serverTimestamp();
  }
  if (verdict.correlationId) {
    updatePayload.auditCorrelationId = verdict.correlationId;
  }

  try {
    await deploymentRef.update(updatePayload);
  } catch (err) {
    // Audit the failure so an investigator can see the reconciler
    // observed the command but couldn't persist the resulting state.
    if (verdict.correlationId) {
      try {
        await writeReconcilerAuditEntry({
          siteId,
          correlationId: verdict.correlationId,
          actorName: 'deployment_reconciler',
          capability: 'DEPLOYMENT_MANAGE',
          targetKind: 'deployment',
          targetId: deploymentId,
          machineId,
          outcome: 'error',
          errorCode: 'parent_write_failed',
          metadata: {
            previousStatus,
            attemptedStatus: verdict.status,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      } catch (auditErr) {
        console.error(
          '[reconcileDeployment] audit write failed after parent write failure',
          auditErr,
        );
      }
    }
    throw err;
  }

  // Best-effort audit append. Failure here is logged but doesn't
  // un-do the parent write (the parent state IS authoritative).
  if (verdict.correlationId) {
    try {
      await writeReconcilerAuditEntry({
        siteId,
        correlationId: verdict.correlationId,
        actorName: 'deployment_reconciler',
        capability: 'DEPLOYMENT_MANAGE',
        targetKind: 'deployment',
        targetId: deploymentId,
        machineId,
        outcome: 'allow',
        metadata: {
          previousStatus,
          newStatus: verdict.status,
          targetStatus: updatedTarget.status,
          becameTerminal: verdict.becameTerminal,
        },
      });
    } catch (err) {
      console.error(
        '[reconcileDeployment] audit write failed (parent write succeeded)',
        err,
      );
    }
  }

  console.log(
    `[reconcileDeployment] site=${siteId} deployment=${deploymentId} ` +
      `machine=${machineId} -> target=${updatedTarget.status} ` +
      `parent=${verdict.status}`,
  );
}
