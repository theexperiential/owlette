/**
 * Project-distribution status reconciler cloud function
 * (security-boundary-migration wave 2.4).
 *
 * Sibling of `reconcileDeploymentStatus` for `distribute_project`
 * commands. Triggers on the same per-machine pending-commands map doc
 * but routes by `distribution_id` instead of `deployment_id`, and
 * lands updates on `sites/{siteId}/project_distributions/{distId}`.
 *
 * Replaces the client-side mutations from `useProjectDistributions`
 * that wave-2 rules lockdown will reject.
 */

import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import {
  diffCommandMap,
  groupByDistributionId,
  reconcileDistribution,
  type ChangedCommand,
  type DistributionTarget,
} from './lib/reconcilerLogic';
import { writeReconcilerAuditEntry } from './lib/reconcilerAudit';

const db = () => admin.firestore();

export const reconcileDistributionStatus = onDocumentUpdated(
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

    const groups = groupByDistributionId(changed);
    if (groups.size === 0) return;

    await Promise.all(
      Array.from(groups.entries()).map(([distributionId, commands]) =>
        reconcileOne(siteId, machineId, distributionId, commands),
      ),
    );
  },
);

async function reconcileOne(
  siteId: string,
  machineId: string,
  distributionId: string,
  commands: ChangedCommand[],
): Promise<void> {
  const distRef = db()
    .collection('sites')
    .doc(siteId)
    .collection('project_distributions')
    .doc(distributionId);

  const snap = await distRef.get();
  if (!snap.exists) {
    console.warn(
      `[reconcileDistribution] distribution ${distributionId} not found ` +
        `(site=${siteId} machine=${machineId}); skipping.`,
    );
    return;
  }

  const data = snap.data() as
    | { status?: string; targets?: DistributionTarget[] }
    | undefined;
  const previousStatus = data?.status;

  const verdict = reconcileDistribution({
    distribution: data ?? {},
    commands,
    machineId,
  });

  if (verdict.kind === 'skip') {
    if (verdict.reason === 'already_processed') {
      console.log(
        `[reconcileDistribution] skip duplicate (site=${siteId} ` +
          `distribution=${distributionId} machine=${machineId})`,
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
    await distRef.update(updatePayload);
  } catch (err) {
    if (verdict.correlationId) {
      try {
        await writeReconcilerAuditEntry({
          siteId,
          correlationId: verdict.correlationId,
          actorName: 'distribution_reconciler',
          capability: 'DISTRIBUTION_MANAGE',
          targetKind: 'distribution',
          targetId: distributionId,
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
          '[reconcileDistribution] audit write failed after parent write failure',
          auditErr,
        );
      }
    }
    throw err;
  }

  if (verdict.correlationId) {
    try {
      await writeReconcilerAuditEntry({
        siteId,
        correlationId: verdict.correlationId,
        actorName: 'distribution_reconciler',
        capability: 'DISTRIBUTION_MANAGE',
        targetKind: 'distribution',
        targetId: distributionId,
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
        '[reconcileDistribution] audit write failed (parent write succeeded)',
        err,
      );
    }
  }

  console.log(
    `[reconcileDistribution] site=${siteId} distribution=${distributionId} ` +
      `machine=${machineId} -> target=${updatedTarget.status} ` +
      `parent=${verdict.status}`,
  );
}
