// REQUIRES composite index on (expiresAt ASC, expiredMarkedAt ASC) — see firestore.indexes.json
/**
 * Scheduled daily sweep of expired api keys (roost public api wave 2.6).
 *
 * For every user's api_keys subcollection:
 *   1. Find entries where `expiresAt < now` and no `expiredMarkedAt` yet.
 *   2. Stamp `expiredMarkedAt` on the subcollection doc so the settings ui
 *      can distinguish "live but soon" from "already expired."
 *   3. Delete the top-level `api_keys/{keyHash}` lookup doc so auth
 *      resolution short-circuits on the missing-doc check rather than
 *      the (slightly later) expiresAt check — belt-and-suspenders with
 *      the request-time check in `resolveApiKeyContext`.
 *
 * Rotated keys already have `retiresAt` stamped; those are handled by the
 * same sweep via the retired-grace code path in resolveApiKeyContext and
 * are cleaned up here once retiresAt is also past.
 *
 * Idempotent: re-running skips keys that already carry `expiredMarkedAt`.
 * Safe to run ad-hoc via `firebase functions:shell` for manual cleanup.
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

  // Collection-group query to scan every user's api_keys subcollection in one
  // pass. Firestore composite index on (expiresAt, expiredMarkedAt) keeps
  // this cheap even with many keys.
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

      // firestore batch cap is 500 writes. Commit midway and start fresh to
      // avoid exceeding the limit when sweeping a backlog.
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

/**
 * Scheduled 03:00 UTC daily. Timeout 120s is generous — even 10k expired
 * keys take well under a minute to mark.
 */
export const sweepExpiredApiKeysDaily = onSchedule(
  { schedule: '0 3 * * *', timeoutSeconds: 120, memory: '256MiB' },
  async () => {
    const summary = await sweepExpiredApiKeys();
    console.log(`[apiKeyExpire] sweep complete: ${JSON.stringify(summary)}`);
  },
);
