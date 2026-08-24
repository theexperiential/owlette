/**
 * Every 5 minutes, fails deployments stuck in non-terminal states — an agent
 * that crashes or loses network never reports back, so nothing else would ever
 * move them. Targets time out at 15min (pending) / 30min (active), then the
 * deployment status is recalculated; writes only happen on a real change.
 *
 * Scale guard: only sites with `lastDeploymentActivityAt` inside the 30-minute
 * window are scanned. Sites missing the field are swept during a 7-day legacy
 * grace period, which lets an active deployment seed the marker.
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore } from 'firebase-admin/firestore';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import {
  calculateDeploymentStatus,
  TARGET_TERMINAL_STATUSES,
  DEPLOYMENT_TERMINAL_STATUSES,
  type DeploymentTarget,
} from './lib/deploymentUtils';

const db = getFirestore();

/** How long a target can sit at "pending" before we fail it (ms). */
const PENDING_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

/** How long a target can sit at "downloading"/"installing" before we fail it (ms). */
const ACTIVE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/** Sites without deployment activity in this window are skipped. */
const RECENT_DEPLOYMENT_ACTIVITY_MS = 30 * 60 * 1000; // 30 minutes

/** End of the legacy full-scan grace window (hardening shipped 2026-05-18). */
const LEGACY_SITE_SCAN_GRACE_UNTIL_MS = Date.parse('2026-05-25T00:00:00.000Z');

export const sweepStaleDeployments = onSchedule(
  { schedule: 'every 5 minutes', timeoutSeconds: 60 },
  async () => {
    const now = Date.now();
    let totalUpdated = 0;

    const sitesToSweep = await getSitesToSweep(now);

    for (const siteDoc of sitesToSweep) {
      const siteId = siteDoc.id;

      const deploymentsSnap = await db
        .collection('sites')
        .doc(siteId)
        .collection('deployments')
        .where('status', 'in', ['pending', 'in_progress'])
        .get();

      if (!deploymentsSnap.empty) {
        await siteDoc.ref.set(
          { lastDeploymentActivityAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
      }

      for (const deploymentDoc of deploymentsSnap.docs) {
        const data = deploymentDoc.data();
        const targets: DeploymentTarget[] = data.targets || [];
        // createdAt is numeric on legacy docs, Timestamp on new ones.
        const rawCreatedAt = data.createdAt;
        const createdAtMs: number = typeof rawCreatedAt === 'number'
          ? rawCreatedAt
          : rawCreatedAt?.toMillis?.() || 0;

        let changed = false;
        const tsNow = Timestamp.now();
        const updatedTargets = targets.map((target) => {
          if (TARGET_TERMINAL_STATUSES.has(target.status)) {
            return target;
          }

          // Baselined on the deployment's createdAt, not any per-target stamp.
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

        const newStatus = calculateDeploymentStatus(updatedTargets);
        const wasTerminal = DEPLOYMENT_TERMINAL_STATUSES.has(data.status);

        const updatePayload: Record<string, unknown> = {
          targets: updatedTargets,
          status: newStatus,
          updatedAt: FieldValue.serverTimestamp(),
        };

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

async function getSitesToSweep(
  nowMs: number,
): Promise<FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>[]> {
  const cutoff = Timestamp.fromMillis(nowMs - RECENT_DEPLOYMENT_ACTIVITY_MS);

  // TODO(index): firestore.indexes.json currently has no explicit composite
  // index for sites.lastDeploymentActivityAt. Add it before deploy if the
  // target Firestore project requires one for this activity-window query.
  const recentSitesSnap = await db
    .collection('sites')
    .where('lastDeploymentActivityAt', '>=', cutoff)
    .get();

  const sitesById = new Map<
    string,
    FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>
  >();
  for (const siteDoc of recentSitesSnap.docs) {
    sitesById.set(siteDoc.id, siteDoc);
  }

  if (nowMs < LEGACY_SITE_SCAN_GRACE_UNTIL_MS) {
    const allSitesSnap = await db.collection('sites').get();
    for (const siteDoc of allSitesSnap.docs) {
      if (siteDoc.data().lastDeploymentActivityAt == null) {
        sitesById.set(siteDoc.id, siteDoc);
      }
    }
  }

  return [...sitesById.values()];
}
