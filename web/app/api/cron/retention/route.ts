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
 * Bounded by design. Each collection is drained page by page until it is empty
 * or the whole-run MAX_DELETES_PER_RUN budget is spent; hitting the budget is
 * the ONLY thing that sets `truncated: true`. Deleting oldest-first means
 * progress is monotonic across runs.
 *
 * `truncated` is a load-bearing signal, not decoration — it is how an operator
 * knows whether data older than the window still exists. Any change that can
 * leave stale documents behind while reporting `truncated: false` reintroduces
 * exactly the silent-underdelivery bug this job was written to remove.
 */

import { NextRequest, NextResponse } from 'next/server';
import { FieldPath, Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { formatDayBucketId } from '@/lib/metricsHistoryBuckets';

/**
 * Retention windows, in days. Mirrored in the privacy policy (section 6) — these
 * are a PUBLIC COMMITMENT, so the constant and the policy text move together.
 *
 * 400, not 365, and NOT 360. MetricsDetailPanel's "year" range resolves to
 * exactly `now - 365 days` (useHistoricalMetrics.getStartDate), so anything
 * below that silently truncates the chart — it renders fine, just with less
 * history than its own label claims, which is the kind of wrong nobody
 * notices. 365 exactly would leave the oldest bucket sitting on the deletion
 * boundary between cron runs; the extra ~5 weeks means the year view is always
 * fully backed.
 *
 * The "all" range is unbounded (`new Date(0)`), so no finite window satisfies
 * it by definition — it shows whatever is retained, which is the honest
 * reading of "all".
 */
export const METRICS_RETENTION_DAYS = 400;
export const LOGS_RETENTION_DAYS = 400;

/** Ceiling on documents removed per invocation, across both collections. */
const MAX_DELETES_PER_RUN = 2_000;
/** Documents fetched per query. Not a commit size — see deleteRefs(). */
const QUERY_PAGE_SIZE = 400;
/** Retry budget per document before a delete is counted as failed. */
const MAX_WRITE_ATTEMPTS = 5;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/**
 * Delete `refs` via BulkWriter.
 *
 * NOT db.batch(). A batched commit of 400 deletes failed in production with
 * `3 INVALID_ARGUMENT: Transaction too big` — the documented 500-writes-per-
 * commit figure is a ceiling, and the effective limit is lower because the
 * backend counts more than one unit per document. BulkWriter is Firestore's
 * supported primitive for bulk deletion: it batches internally, ramps
 * throughput to avoid contention, and retries retryable failures.
 *
 * Returns the number actually removed, so a partial failure is reported as a
 * smaller count rather than silently inflating the run's totals.
 */
async function deleteRefs(
  db: FirebaseFirestore.Firestore,
  refs: FirebaseFirestore.DocumentReference[]
): Promise<number> {
  if (refs.length === 0) return 0;

  const writer = db.bulkWriter();
  let failed = 0;

  writer.onWriteError(error => {
    if (error.failedAttempts < MAX_WRITE_ATTEMPTS) return true;
    failed += 1;
    console.error(
      `[retention] gave up deleting ${error.documentRef.path}: ${error.message}`
    );
    return false;
  });

  for (const ref of refs) {
    // The per-op promise rejects once onWriteError stops retrying; that case is
    // already counted above, so swallow it here to avoid an unhandled rejection.
    void writer.delete(ref).catch(() => undefined);
  }

  await writer.close();
  return refs.length - failed;
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
      // Drain in pages rather than taking a single page per site. A single
      // page left older data behind while the response still reported
      // truncated:false, i.e. "nothing left to do" — which is exactly the
      // silent-underdelivery failure this job exists to prevent.
      while (budget > 0) {
        const pageSize = Math.min(budget, QUERY_PAGE_SIZE);
        const staleLogs = await site.ref
          .collection('logs')
          .where('timestamp', '<', logsCutoff)
          .orderBy('timestamp', 'asc')
          .limit(pageSize)
          .get();

        if (staleLogs.empty) break;

        const removed = await deleteRefs(db, staleLogs.docs.map(d => d.ref));
        logsDeleted += removed;
        budget -= removed;

        // A short page means the collection is drained for this cutoff.
        if (staleLogs.size < pageSize) break;
      }

      if (budget <= 0) break;

      // --- metrics history --------------------------------------------
      const machines = await site.ref.collection('machines').get();
      for (const machine of machines.docs) {
        if (budget <= 0) break;

        while (budget > 0) {
          const pageSize = Math.min(budget, QUERY_PAGE_SIZE);
          const staleBuckets = await machine.ref
            .collection('metrics_history')
            .where(FieldPath.documentId(), '<', metricsCutoffBucket)
            .orderBy(FieldPath.documentId(), 'asc')
            .limit(pageSize)
            .get();

          if (staleBuckets.empty) break;

          const removed = await deleteRefs(db, staleBuckets.docs.map(d => d.ref));
          metricsDeleted += removed;
          budget -= removed;

          if (staleBuckets.size < pageSize) break;
        }
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
