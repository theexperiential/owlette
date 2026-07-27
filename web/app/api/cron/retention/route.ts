/**
 * GET /api/cron/retention
 *
 * Deletes time-series data past its retention window. This is the job that
 * backs the retention commitment in the privacy policy (section 6) — before it
 * existed, the policy claimed "machine metrics: rolling 30-90 days" and
 * "event logs: up to 90 days" with nothing enforcing either.
 *
 * What it prunes:
 *   - `sites/{siteId}/machines/{machineId}/metrics_history/{bucketId}`
 *     Bucket ids encode UTC time (`YYYY-MM-DD-HH` hourly, `YYYY-MM-DD` legacy
 *     daily — see lib/metricsHistoryBuckets.ts), so these are deletable by
 *     document-id range with no timestamp field and no composite index. The
 *     two id shapes share a common date prefix and sort correctly against a
 *     `YYYY-MM-DD` cutoff: '2026-04-26-23' < '2026-04-27' < '2026-04-27-00'.
 *   - `sites/{siteId}/logs/{logId}` by the indexed `timestamp` field.
 *
 * Deliberately NOT a Firestore TTL policy: TTL needs an `expireAt` field on
 * every document, which would mean changing the agent/function write paths and
 * backfilling existing data. This runs on the same cron-job.org schedule as the
 * other four jobs and needs no console-side configuration.
 *
 * Bounded by design. Each run stops at MAX_DELETES_PER_RUN and reports
 * `truncated: true`; the next run continues. That keeps a first run against a
 * large backlog from running long or blowing through Firestore write limits,
 * at the cost of taking several runs to drain. Deleting oldest-first means
 * progress is monotonic.
 */

import { NextRequest, NextResponse } from 'next/server';
import { FieldPath, Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { formatDayBucketId } from '@/lib/metricsHistoryBuckets';

/** Retention windows, in days. Mirrored in the privacy policy (section 6). */
export const METRICS_RETENTION_DAYS = 90;
export const LOGS_RETENTION_DAYS = 90;

/**
 * Ceiling on documents removed per invocation, across both collections.
 * Firestore commits cap at 500 writes per batch; this is a whole-run budget.
 */
const MAX_DELETES_PER_RUN = 2_000;
const BATCH_SIZE = 400;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/** Commit `refs` in chunks that respect the 500-writes-per-batch limit. */
async function deleteRefs(
  db: FirebaseFirestore.Firestore,
  refs: FirebaseFirestore.DocumentReference[]
): Promise<number> {
  let removed = 0;
  for (let i = 0; i < refs.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + BATCH_SIZE)) batch.delete(ref);
    await batch.commit();
    removed += Math.min(BATCH_SIZE, refs.length - i);
  }
  return removed;
}

export async function GET(request: NextRequest) {
  const cronSecret = request.headers.get('x-cron-secret');
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const db = getAdminDb();
    const metricsCutoffBucket = formatDayBucketId(daysAgo(METRICS_RETENTION_DAYS));
    const logsCutoff = Timestamp.fromDate(daysAgo(LOGS_RETENTION_DAYS));

    let budget = MAX_DELETES_PER_RUN;
    let metricsDeleted = 0;
    let logsDeleted = 0;

    const sites = await db.collection('sites').get();

    for (const site of sites.docs) {
      if (budget <= 0) break;

      // --- event logs -------------------------------------------------
      const staleLogs = await site.ref
        .collection('logs')
        .where('timestamp', '<', logsCutoff)
        .orderBy('timestamp', 'asc')
        .limit(Math.min(budget, BATCH_SIZE))
        .get();

      if (!staleLogs.empty) {
        const removed = await deleteRefs(db, staleLogs.docs.map(d => d.ref));
        logsDeleted += removed;
        budget -= removed;
      }

      if (budget <= 0) break;

      // --- metrics history --------------------------------------------
      const machines = await site.ref.collection('machines').get();
      for (const machine of machines.docs) {
        if (budget <= 0) break;

        const staleBuckets = await machine.ref
          .collection('metrics_history')
          .where(FieldPath.documentId(), '<', metricsCutoffBucket)
          .orderBy(FieldPath.documentId(), 'asc')
          .limit(Math.min(budget, BATCH_SIZE))
          .get();

        if (staleBuckets.empty) continue;

        const removed = await deleteRefs(db, staleBuckets.docs.map(d => d.ref));
        metricsDeleted += removed;
        budget -= removed;
      }
    }

    const truncated = budget <= 0;
    console.log(
      `[retention] metrics=${metricsDeleted} logs=${logsDeleted} truncated=${truncated}`
    );

    return NextResponse.json({
      ok: true,
      deleted: { metrics: metricsDeleted, logs: logsDeleted },
      cutoffs: {
        metricsBucket: metricsCutoffBucket,
        logs: logsCutoff.toDate().toISOString(),
      },
      retentionDays: {
        metrics: METRICS_RETENTION_DAYS,
        logs: LOGS_RETENTION_DAYS,
      },
      // true => the per-run ceiling was hit and older data remains; the next
      // scheduled run continues from the same oldest-first position.
      truncated,
    });
  } catch (error) {
    console.error('[retention] failed:', error);
    return NextResponse.json({ error: 'Retention sweep failed' }, { status: 500 });
  }
}
