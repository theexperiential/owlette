/**
 * Pure planning for roost chunk garbage collection; execution lives in
 * chunkGc.ts. Deterministic given its inputs, which is what makes dry-run safe.
 *
 * A chunk is garbage when no current or recent-history version references it.
 * Two phases survive the race with a not-yet-finalised upload:
 *   1. mark — tombstone any stored-but-unreferenced chunk (timestamped).
 *   2. sweep — delete tombstones past the TTL, but ONLY if still unreferenced.
 *      That re-check is the resurrection guard.
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
  /** Orphans with no tombstone record yet. */
  toTombstone: string[];
  /** Tombstone past TTL, still orphaned, still stored. */
  toDelete: string[];
  /** Chunk was referenced again, or vanished from storage on its own. */
  tombstonesToClear: string[];
  /** Not yet ripe, still orphaned. Audit-only; execution ignores it. */
  tombstonesRetained: TombstoneRecord[];
}

/** Deterministic, side-effect free; the handler applies (or logs, in dry-run). */
export function planGc(input: GcPlanInput): GcPlan {
  const ttl = input.tombstoneTtlMs ?? TOMBSTONE_TTL_MS;

  const tombIndex = new Map<string, TombstoneRecord>();
  for (const t of input.tombstones) {
    // Duplicate tombstones for one hash shouldn't happen, but on firestore
    // concurrency keep the OLDEST — its TTL elapses first.
    const existing = tombIndex.get(t.hash);
    if (!existing || t.tombstonedAt < existing.tombstonedAt) {
      tombIndex.set(t.hash, t);
    }
  }

  const toTombstone: string[] = [];
  const toDelete: string[] = [];
  const tombstonesToClear: string[] = [];
  const tombstonesRetained: TombstoneRecord[] = [];

  // Phase 1. Iterate `stored`, not `referenced`: only existing chunks get
  // tombstoned; a referenced-but-unstored chunk is an upload/finalize race.
  // Sorted for deterministic output — tests rely on it.
  const storedSorted = [...input.stored].sort();
  for (const hash of storedSorted) {
    if (input.referenced.has(hash)) {
      // Resurrection: drop any stale tombstone.
      if (tombIndex.has(hash)) tombstonesToClear.push(hash);
      continue;
    }
    const existing = tombIndex.get(hash);
    if (!existing) {
      toTombstone.push(hash);
      continue;
    }
    if (input.now - existing.tombstonedAt >= ttl) {
      toDelete.push(hash);
    } else {
      tombstonesRetained.push(existing);
    }
  }

  // Phase 2: clear tombstones whose chunk vanished out of band, or they linger
  // forever. Not in `toDelete` — there is nothing left to delete.
  const tombstonedSorted = [...tombIndex.keys()].sort();
  for (const hash of tombstonedSorted) {
    if (!input.stored.has(hash) && !tombstonesToClear.includes(hash)) {
      tombstonesToClear.push(hash);
    }
  }

  return { toTombstone, toDelete, tombstonesToClear, tombstonesRetained };
}

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
