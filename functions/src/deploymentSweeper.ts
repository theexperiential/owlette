/**
 * Deployment Sweeper Cloud Function
 *
 * Runs every 5 minutes to catch deployments stuck in non-terminal states.
 * This handles the case where an agent crashes, loses network, or otherwise
 * fails to report back — the deployment would be stuck forever without this.
 *
 * Rules:
 * - Targets stuck at "pending" for > 15 minutes → marked "failed" (timeout)
 * - Targets at "downloading" or "installing" for > 30 minutes → marked "failed"
 * - Recalculates overall deployment status after updating targets
 * - Only writes if something actually changed
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import {
  calculateDeploymentStatus,
  TARGET_TERMINAL_STATUSES,
  DEPLOYMENT_TERMINAL_STATUSES,
  type DeploymentTarget,
} from './lib/deploymentUtils';

const db = admin.firestore();

/** How long a target can sit at "pending" before we fail it (ms). */
const PENDING_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

/** How long a target can sit at "downloading"/"installing" before we fail it (ms). */
const ACTIVE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Scheduled function that sweeps stale deployments.
 * Runs every 5 minutes via Cloud Scheduler.
 */
export const sweepStaleDeployments = onSchedule(
  { schedule: 'every 5 minutes', timeoutSeconds: 60 },
  async () => {
    const now = Date.now();
    let totalUpdated = 0;

    // Get all sites
    const sitesSnap = await db.collection('sites').get();

    for (const siteDoc of sitesSnap.docs) {
      const siteId = siteDoc.id;

      // Query non-terminal deployments for this site
      const deploymentsSnap = await db
        .collection('sites')
        .doc(siteId)
        .collection('deployments')
        .where('status', 'in', ['pending', 'in_progress'])
        .get();

      for (const deploymentDoc of deploymentsSnap.docs) {
        const data = deploymentDoc.data();
        const targets: DeploymentTarget[] = data.targets || [];
        // Handle both numeric (legacy) and Timestamp (new) createdAt
        const rawCreatedAt = data.createdAt;
        const createdAtMs: number = typeof rawCreatedAt === 'number'
          ? rawCreatedAt
          : rawCreatedAt?.toMillis?.() || 0;

        let changed = false;
        const tsNow = Timestamp.now();
        const updatedTargets = targets.map((target) => {
          // Skip targets that are already terminal
          if (TARGET_TERMINAL_STATUSES.has(target.status)) {
            return target;
          }

          // Determine the relevant timestamp for this target
          // Use createdAt as the baseline (when the deployment was created)
          const targetAge = now - createdAtMs;

          if (target.status === 'pending' && targetAge > PENDING_TIMEOUT_MS) {
            changed = true;
            return {
              ...target,
              status: 'failed',
              error: `Timed out: agent did not start after ${Math.round(PENDING_TIMEOUT_MS / 60000)} minutes`,
              completedAt: tsNow,
            };
          }

          if (
            ['downloading', 'installing', 'uninstalling'].includes(target.status) &&
            targetAge > ACTIVE_TIMEOUT_MS
          ) {
            changed = true;
            return {
              ...target,
              status: 'failed',
              error: `Timed out: agent stalled during ${target.status} after ${Math.round(ACTIVE_TIMEOUT_MS / 60000)} minutes`,
              completedAt: tsNow,
            };
          }

          return target;
        });

        if (!changed) continue;

        // Recalculate overall status
        const newStatus = calculateDeploymentStatus(updatedTargets);
        const wasTerminal = DEPLOYMENT_TERMINAL_STATUSES.has(data.status);

        const updatePayload: Record<string, unknown> = {
          targets: updatedTargets,
          status: newStatus,
          updatedAt: FieldValue.serverTimestamp(),
        };

        // Set completedAt if deployment just became terminal
        if (!wasTerminal && DEPLOYMENT_TERMINAL_STATUSES.has(newStatus)) {
          updatePayload.completedAt = FieldValue.serverTimestamp();
        }

        await deploymentDoc.ref.update(updatePayload);
        totalUpdated++;

        console.log(
          `Sweeper: deployment ${deploymentDoc.id} (site ${siteId}) -> ${newStatus}`
        );
      }
    }

    if (totalUpdated > 0) {
      console.log(`Sweeper: updated ${totalUpdated} stale deployment(s)`);
    }
  }
);
