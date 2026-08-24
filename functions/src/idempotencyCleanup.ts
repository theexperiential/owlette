/**
 * Scheduled cleanup of expired idempotency cache entries (roost public api wave 3.12).
 *
 * `idempotency_cache/{hash}` carries an `expiresAt` unix-ms field, written by the web
 * layer's `saveIdempotency` with a 24h ttl; a daily sweep deletes anything past it.
 *
 * The only retention mechanism — firestore has no native ttl, so without this the
 * collection grows unbounded.
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore } from 'firebase-admin/firestore';

const BATCH_LIMIT = 400;

export interface CleanupSummary {
  scanned: number;
  deleted: number;
  errors: number;
}

export async function sweepExpiredIdempotencyCache(
  now = Date.now(),
): Promise<CleanupSummary> {
  const db = getFirestore();
  const summary: CleanupSummary = { scanned: 0, deleted: 0, errors: 0 };

  const expired = await db
    .collection('idempotency_cache')
    .where('expiresAt', '<', now)
    .get();

  let batch = db.batch();
  let opsInBatch = 0;

  for (const doc of expired.docs) {
    summary.scanned += 1;
    try {
      batch.delete(doc.ref);
      opsInBatch += 1;
      summary.deleted += 1;

      // firestore caps a batch at 500 writes. Commit mid-stream for big backlogs.
      if (opsInBatch >= BATCH_LIMIT) {
        await batch.commit();
        batch = db.batch();
        opsInBatch = 0;
      }
    } catch (err) {
      summary.errors += 1;
      console.error(
        `[idempotencyCleanup] error on ${doc.ref.path}: ${(err as Error).message}`,
      );
    }
  }

  if (opsInBatch > 0) await batch.commit();
  return summary;
}

/**
 * Daily at 03:30 UTC — interleaves with the other daily sweepers
 * (api keys 03:00, chunkGc 02:15, telemetry 04:30, audit 05:15).
 */
export const sweepExpiredIdempotencyCacheDaily = onSchedule(
  { schedule: '30 3 * * *', timeoutSeconds: 120, memory: '256MiB' },
  async () => {
    const summary = await sweepExpiredIdempotencyCache();
    console.log(
      `[idempotencyCleanup] sweep complete: ${JSON.stringify(summary)}`,
    );
  },
);
