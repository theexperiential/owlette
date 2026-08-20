// REQUIRES composite index on (expiresAt ASC, expiredMarkedAt ASC) — see firestore.indexes.json
/**
 * Daily sweep of expired api keys. For each user's api_keys subcollection, finds
 * `expiresAt < now` without `expiredMarkedAt`, stamps `expiredMarkedAt` (so the
 * settings ui can tell "expiring" from "expired"), and deletes the top-level
 * `api_keys/{keyHash}` lookup so auth fails on the missing-doc check rather than
 * the later expiresAt check — belt-and-braces with `resolveApiKeyContext`.
 *
 * Rotated keys carry `retiresAt` and are cleaned up here once that is also past.
 * Idempotent (already-marked keys are skipped), so it is safe to run ad hoc via
 * `firebase functions:shell`.
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';

const BATCH_LIMIT = 400;

interface SweepSummary {
  keysScanned: number;
  keysMarkedExpired: number;
  lookupsDeleted: number;
  errors: number;
}

export async function sweepExpiredApiKeys(now = Date.now()): Promise<SweepSummary> {
  const db = admin.firestore();
  const summary: SweepSummary = {
    keysScanned: 0,
    keysMarkedExpired: 0,
    lookupsDeleted: 0,
    errors: 0,
  };

  // Collection-group scan of every user's api_keys in one pass; the
  // (expiresAt, expiredMarkedAt) composite index keeps it cheap.
  const expired = await db
    .collectionGroup('api_keys')
    .where('expiresAt', '<', now)
    .where('expiredMarkedAt', '==', null)
    .get();

  let batch = db.batch();
  let opsInBatch = 0;

  for (const doc of expired.docs) {
    summary.keysScanned += 1;
    const data = doc.data() as {
      keyHash?: string;
      expiredMarkedAt?: unknown;
    };

    if (data.expiredMarkedAt) continue;

    try {
      batch.update(doc.ref, {
        expiredMarkedAt: FieldValue.serverTimestamp(),
      });
      opsInBatch += 1;
      summary.keysMarkedExpired += 1;

      if (data.keyHash && typeof data.keyHash === 'string') {
        batch.delete(db.collection('api_keys').doc(data.keyHash));
        opsInBatch += 1;
        summary.lookupsDeleted += 1;
      }

      // Firestore batches cap at 500 writes — commit and start a fresh one.
      if (opsInBatch >= BATCH_LIMIT) {
        await batch.commit();
        batch = db.batch();
        opsInBatch = 0;
      }
    } catch (err) {
      summary.errors += 1;
      console.error(
        `[apiKeyExpire] error on ${doc.ref.path}: ${(err as Error).message}`,
      );
    }
  }

  if (opsInBatch > 0) {
    await batch.commit();
  }

  return summary;
}

/** Daily at 03:00 UTC; 120s timeout covers well over 10k keys. */
export const sweepExpiredApiKeysDaily = onSchedule(
  { schedule: '0 3 * * *', timeoutSeconds: 120, memory: '256MiB' },
  async () => {
    const summary = await sweepExpiredApiKeys();
    console.log(`[apiKeyExpire] sweep complete: ${JSON.stringify(summary)}`);
  },
);
