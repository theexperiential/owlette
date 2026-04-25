/**
 * Scheduled chunk garbage collection (roost wave 2b.4).
 *
 * Runs nightly (off-peak UTC). For each site:
 *   1. Skip sites with an in-flight rollout (pause-during-publish).
 *   2. Gather the referenced-hash set (live versions) and the stored-
 *      hash set (R2 listing under the per-tenant prefix).
 *   3. Load existing tombstones.
 *   4. Produce a plan (pure function — lib/chunkGcLogic.ts).
 *   5. Apply the plan OR log it (dry-run).
 *
 * Dry-run is the default for the first production month (env
 * `CHUNK_GC_MODE=dry-run`) so operators can audit the plan against
 * real storage without risking data loss. Set `CHUNK_GC_MODE=apply`
 * only after 30 days of clean dry-runs.
 *
 * The R2 listing + firestore-heavy scans are stubbed behind a
 * `SiteScanner` interface. Wave 0.5 provisions R2 + wires the
 * production scanner; everything else is testable today.
 *
 * Not in scope (follow-up):
 *   - Denormalised chunk refcount doc to avoid scanning every version.
 *     Without it, sites with thousands of versions will be slow. The
 *     current implementation assumes the scanner is smart about that.
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import {
  planGc,
  summarisePlan,
  TOMBSTONE_TTL_MS,
  type TombstoneRecord,
} from './lib/chunkGcLogic';

/* --------------------------------------------------------------------- */
/*  Dependency interfaces (injectable for tests + deploy wiring)         */
/* --------------------------------------------------------------------- */

export interface ObjectStore {
  /** List all chunk hashes stored under the per-tenant prefix. */
  listStoredHashes(siteId: string): Promise<Set<string>>;
  /** Delete a chunk by hash. Idempotent. */
  deleteChunk(siteId: string, hash: string): Promise<void>;
}

export interface SiteScanner {
  /**
   * Return every site id known to the system. Production: firestore
   * top-level `sites/` collection listing.
   */
  listSiteIds(): Promise<string[]>;
  /**
   * Return the hash set referenced by any live version for this site.
   * "Live" = currentVersionId + previousVersionId + any still in
   * rollout history within the retention window. Production: reads
   * every doc under `sites/{siteId}/roosts` and each roost's
   * `rollouts` subcollection, plus the versions.
   */
  getReferencedHashes(siteId: string): Promise<Set<string>>;
  /**
   * True if there is a non-terminal rollout active on this site.
   * Pause GC while publishing to avoid racing with an in-flight upload
   * whose version has not yet been finalised.
   */
  hasActiveRollout(siteId: string): Promise<boolean>;
}

export interface TombstoneStore {
  list(siteId: string): Promise<TombstoneRecord[]>;
  /** Atomically create new tombstones. */
  create(siteId: string, hashes: string[], now: Date): Promise<void>;
  /** Atomically remove tombstone metadata (no chunk delete). */
  clear(siteId: string, hashes: string[]): Promise<void>;
}

/* --------------------------------------------------------------------- */
/*  Pure orchestrator (testable)                                         */
/* --------------------------------------------------------------------- */

export type GcMode = 'dry-run' | 'apply';

export interface GcDeps {
  scanner: SiteScanner;
  store: ObjectStore;
  tombstones: TombstoneStore;
  mode: GcMode;
  /** injected for determinism in tests. */
  now?: () => Date;
}

export interface SiteGcResult {
  siteId: string;
  skipped: boolean;
  skipReason?: string;
  summary?: ReturnType<typeof summarisePlan>;
  mode: GcMode;
}

/** GC one site end-to-end, returning what happened. */
export async function gcOneSite(
  siteId: string,
  deps: GcDeps,
): Promise<SiteGcResult> {
  const now = deps.now ? deps.now() : new Date();

  if (await deps.scanner.hasActiveRollout(siteId)) {
    return {
      siteId,
      skipped: true,
      skipReason: 'active_rollout',
      mode: deps.mode,
    };
  }

  const [referenced, stored, tombstones] = await Promise.all([
    deps.scanner.getReferencedHashes(siteId),
    deps.store.listStoredHashes(siteId),
    deps.tombstones.list(siteId),
  ]);

  const plan = planGc({
    referenced,
    stored,
    tombstones,
    now: now.getTime(),
  });
  const summary = summarisePlan(plan);

  if (deps.mode === 'dry-run') {
    logDryRun(siteId, plan, summary);
    return { siteId, skipped: false, summary, mode: 'dry-run' };
  }

  if (!summary.hasChanges) {
    return { siteId, skipped: false, summary, mode: 'apply' };
  }

  // Ordering matters: tombstone FIRST so if a deletion fails mid-way,
  // the state is consistent (tombstones exist, deletions are retried
  // on the next run). Then clear stale tombstones, then delete ripe
  // chunks. If a delete fails, the tombstone remains ripe and next run
  // picks it up.
  if (plan.toTombstone.length > 0) {
    await deps.tombstones.create(siteId, plan.toTombstone, now);
  }
  if (plan.tombstonesToClear.length > 0) {
    await deps.tombstones.clear(siteId, plan.tombstonesToClear);
  }
  for (const hash of plan.toDelete) {
    try {
      await deps.store.deleteChunk(siteId, hash);
      await deps.tombstones.clear(siteId, [hash]);
    } catch (err) {
      // individual delete failure doesn't tank the whole site — log + continue.
      console.error(
        `[chunkGc] delete failed for ${siteId}/${hash}: ${
          (err as Error).message
        }`,
      );
    }
  }

  return { siteId, skipped: false, summary, mode: 'apply' };
}

export async function gcAllSites(deps: GcDeps): Promise<SiteGcResult[]> {
  const siteIds = await deps.scanner.listSiteIds();
  const results: SiteGcResult[] = [];
  for (const siteId of siteIds) {
    try {
      const r = await gcOneSite(siteId, deps);
      results.push(r);
    } catch (err) {
      console.error(
        `[chunkGc] unhandled error for site ${siteId}: ${
          (err as Error).message
        }`,
      );
      results.push({
        siteId,
        skipped: true,
        skipReason: `error: ${(err as Error).message}`,
        mode: deps.mode,
      });
    }
  }
  return results;
}

function logDryRun(
  siteId: string,
  plan: ReturnType<typeof planGc>,
  summary: ReturnType<typeof summarisePlan>,
): void {
  console.log(
    `[chunkGc:dry-run] site=${siteId} ` +
      `would_tombstone=${summary.newTombstones} ` +
      `would_delete=${summary.deletions} ` +
      `would_clear_tombstones=${summary.tombstonesCleared} ` +
      `tombstone_backlog=${summary.tombstonesRetained}`,
  );
  if (plan.toDelete.length > 0) {
    // first 5 as a sample — don't blow the log on a huge sweep.
    const sample = plan.toDelete.slice(0, 5).join(', ');
    console.log(
      `[chunkGc:dry-run] ${siteId} sample delete candidates: ${sample}${
        plan.toDelete.length > 5 ? ` (+${plan.toDelete.length - 5} more)` : ''
      }`,
    );
  }
}

/* --------------------------------------------------------------------- */
/*  Scheduled entrypoint                                                 */
/* --------------------------------------------------------------------- */

/**
 * Scheduled 02:15 UTC daily. Timeout 540s (9 min — scheduler cap for
 * low-cost functions). Per-site work is sequential; parallelism is
 * limited by firestore quota on the scanner.
 */
export const chunkGcNightly = onSchedule(
  { schedule: '15 2 * * *', timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    const mode: GcMode = process.env.CHUNK_GC_MODE === 'apply' ? 'apply' : 'dry-run';
    const deps: GcDeps = {
      scanner: getDefaultScanner(),
      store: getDefaultStore(),
      tombstones: getDefaultTombstoneStore(),
      mode,
    };
    const results = await gcAllSites(deps);
    const summary = {
      mode,
      sites: results.length,
      skipped: results.filter((r) => r.skipped).length,
      active_rollout_skipped: results.filter(
        (r) => r.skipReason === 'active_rollout',
      ).length,
      total_tombstoned: results.reduce(
        (n, r) => n + (r.summary?.newTombstones ?? 0),
        0,
      ),
      total_deleted: results.reduce(
        (n, r) => n + (r.summary?.deletions ?? 0),
        0,
      ),
    };
    console.log(`[chunkGc] run complete: ${JSON.stringify(summary)}`);
  },
);

/* --------------------------------------------------------------------- */
/*  Production wiring (injected at deploy time)                          */
/* --------------------------------------------------------------------- */

function getDefaultScanner(): SiteScanner {
  // firestore-backed implementation will go here post wave 0.6.
  // reading every version every night is the lazy approach and is
  // adequate at Owlette's expected fleet size (≤ low thousands of
  // versions per site). a denormalised refcount doc is the long-term
  // fix; tracked as a follow-up.
  const db = admin.firestore();
  return {
    async listSiteIds() {
      const snap = await db.collection('sites').listDocuments();
      return snap.map((d) => d.id);
    },
    async getReferencedHashes(siteId: string) {
      const referenced = new Set<string>();
      const roostsSnap = await db
        .collection('sites')
        .doc(siteId)
        .collection('roosts')
        .get();
      for (const roostDoc of roostsSnap.docs) {
        const versionsSnap = await roostDoc.ref
          .collection('versions')
          .get();
        for (const vDoc of versionsSnap.docs) {
          const chunks = (vDoc.data() as { chunks?: string[] }).chunks;
          if (Array.isArray(chunks)) for (const h of chunks) referenced.add(h);
        }
      }
      return referenced;
    },
    async hasActiveRollout(siteId: string) {
      // check any roost with an in-flight rollout doc.
      const roostsSnap = await db
        .collection('sites')
        .doc(siteId)
        .collection('roosts')
        .get();
      for (const roostDoc of roostsSnap.docs) {
        const rolloutsSnap = await roostDoc.ref
          .collection('rollouts')
          .where('stage', 'in', ['canary', 'fleet'])
          .limit(1)
          .get();
        if (!rolloutsSnap.empty) return true;
      }
      return false;
    },
  };
}

function getDefaultStore(): ObjectStore {
  return {
    async listStoredHashes(_siteId: string) {
      throw new Error(
        'R2 object store not wired — blocked on wave 0.5 (cloudflare r2 setup)',
      );
    },
    async deleteChunk(_siteId: string, _hash: string) {
      throw new Error(
        'R2 object store not wired — blocked on wave 0.5 (cloudflare r2 setup)',
      );
    },
  };
}

function getDefaultTombstoneStore(): TombstoneStore {
  const db = admin.firestore();
  const col = (siteId: string) =>
    db.collection('sites').doc(siteId).collection('chunk_tombstones');
  return {
    async list(siteId: string) {
      const snap = await col(siteId).get();
      return snap.docs.map((d) => ({
        hash: d.id,
        tombstonedAt: (
          d.data().tombstonedAt as FirebaseFirestore.Timestamp
        ).toMillis(),
      }));
    },
    async create(siteId: string, hashes: string[], now: Date) {
      const batch = db.batch();
      for (const hash of hashes) {
        batch.set(col(siteId).doc(hash), {
          tombstonedAt: FieldValue.serverTimestamp(),
          plannedDeleteAfter: new Date(now.getTime() + TOMBSTONE_TTL_MS),
        });
      }
      await batch.commit();
    },
    async clear(siteId: string, hashes: string[]) {
      const batch = db.batch();
      for (const hash of hashes) {
        batch.delete(col(siteId).doc(hash));
      }
      await batch.commit();
    },
  };
}
