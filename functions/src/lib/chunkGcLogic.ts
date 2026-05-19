/**
 * Pure logic for roost chunk garbage collection (wave 2b.4).
 *
 * A chunk is garbage when NO current version AND NO recent-history
 * version references it. GC uses a **two-phase** model to survive races
 * between a newly-uploaded-but-not-yet-finalised version and the sweep:
 *
 *   1. Mark phase: any stored-but-not-referenced chunk is tombstoned.
 *      Tombstones live in firestore with a creation timestamp.
 *   2. Sweep phase: tombstones older than the TTL (30 days) are eligible
 *      for deletion — BUT only if the chunk is STILL not referenced.
 *      The re-check on the second phase is the resurrection guard: if
 *      a new version brought the chunk back to life between marking
 *      and sweeping, we drop the tombstone and keep the chunk.
 *
 * Operational mode is split into planning (this module) and execution
 * (chunkGc.ts). The plan is deterministic given inputs, which makes
 * dry-run mode trivially safe: produce the plan, log it, skip the writes.
 *
 * NOT in scope here:
 *   - actually reading R2 listings / firestore docs (done by the handler)
 *   - emitting telemetry
 *   - pause-during-publish decision (handler checks before calling us)
 */

/** TTL between tombstone and actual deletion. 30 days (ms). */
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A recorded tombstone: chunk was marked for deletion at this moment. */
export interface TombstoneRecord {
  hash: string;
  /** unix ms when the tombstone was written */
  tombstonedAt: number;
}

export interface GcPlanInput {
  /** hashes referenced by any live version (current or previous). */
  referenced: ReadonlySet<string>;
  /** hashes currently present in object storage under this tenant. */
  stored: ReadonlySet<string>;
  /** existing tombstone records from prior GC runs. */
  tombstones: readonly TombstoneRecord[];
  /** current unix ms. injected for determinism in tests. */
  now: number;
  /** override the default TTL (tests). */
  tombstoneTtlMs?: number;
}

export interface GcPlan {
  /**
   * Hashes to tombstone on this run. These are orphans that have no
   * existing tombstone record yet.
   */
  toTombstone: string[];
  /**
   * Hashes to delete on this run. These had a tombstone older than the
   * TTL AND are still orphaned (not referenced) AND are still stored.
   */
  toDelete: string[];
  /**
   * Tombstone records to clear because the chunk came back to life
   * (referenced again) or disappeared from storage on its own.
   */
  tombstonesToClear: string[];
  /**
   * Tombstones kept on this run (not yet ripe, still orphaned).
   * Returned for transparency / auditing, not required for execution.
   */
  tombstonesRetained: TombstoneRecord[];
}

/**
 * Produce the GC plan. Deterministic and side-effect free — feed inputs,
 * get back three lists. The handler applies them (or logs, in dry-run).
 */
export function planGc(input: GcPlanInput): GcPlan {
  const ttl = input.tombstoneTtlMs ?? TOMBSTONE_TTL_MS;

  // Index tombstones by hash for O(1) lookup + stable ordering downstream.
  const tombIndex = new Map<string, TombstoneRecord>();
  for (const t of input.tombstones) {
    // if the same hash has multiple tombstones (shouldn't happen, but
    // firestore concurrency), keep the OLDEST — that's the one whose
    // TTL elapses first.
    const existing = tombIndex.get(t.hash);
    if (!existing || t.tombstonedAt < existing.tombstonedAt) {
      tombIndex.set(t.hash, t);
    }
  }

  const toTombstone: string[] = [];
  const toDelete: string[] = [];
  const tombstonesToClear: string[] = [];
  const tombstonesRetained: TombstoneRecord[] = [];

  // Phase 1: consider each stored chunk for marking.
  // Iterate `stored` (not `referenced`) because we only tombstone things
  // that EXIST; referenced chunks that aren't stored yet are a different
  // problem (upload raced with version finalize).
  // Sort for deterministic output ordering — tests rely on it.
  const storedSorted = [...input.stored].sort();
  for (const hash of storedSorted) {
    if (input.referenced.has(hash)) {
      // live chunk. if it has a stale tombstone, drop it (resurrection).
      if (tombIndex.has(hash)) tombstonesToClear.push(hash);
      continue;
    }
    // orphan
    const existing = tombIndex.get(hash);
    if (!existing) {
      toTombstone.push(hash);
      continue;
    }
    // orphan with tombstone: is it ripe?
    if (input.now - existing.tombstonedAt >= ttl) {
      toDelete.push(hash);
    } else {
      tombstonesRetained.push(existing);
    }
  }

  // Phase 2: tombstones whose chunk has disappeared from storage (e.g.
  // deleted out of band) should also be cleared — otherwise they linger
  // in the tombstone collection forever. Don't include these in `toDelete`
  // (nothing to delete), just clear the metadata.
  const tombstonedSorted = [...tombIndex.keys()].sort();
  for (const hash of tombstonedSorted) {
    if (!input.stored.has(hash) && !tombstonesToClear.includes(hash)) {
      tombstonesToClear.push(hash);
    }
  }

  return { toTombstone, toDelete, tombstonesToClear, tombstonesRetained };
}

/* --------------------------------------------------------------------- */
/*  Summary helpers                                                      */
/* --------------------------------------------------------------------- */

export interface GcSummary {
  /** True iff the plan would cause any mutations. */
  hasChanges: boolean;
  newTombstones: number;
  deletions: number;
  tombstonesCleared: number;
  tombstonesRetained: number;
}

export function summarisePlan(plan: GcPlan): GcSummary {
  const newTombstones = plan.toTombstone.length;
  const deletions = plan.toDelete.length;
  const tombstonesCleared = plan.tombstonesToClear.length;
  const tombstonesRetained = plan.tombstonesRetained.length;
  return {
    hasChanges: newTombstones + deletions + tombstonesCleared > 0,
    newTombstones,
    deletions,
    tombstonesCleared,
    tombstonesRetained,
  };
}
