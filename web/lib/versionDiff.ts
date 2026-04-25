/**
 * Pure version diff for roost rollback UI (wave 3.7).
 *
 * Given two versions (the current `from` and the rollback target `to`),
 * partition their files into add/remove/change/unchanged buckets so the
 * rollback dialog can show "what will actually happen" before the
 * operator flips the pointer.
 *
 * This mirrors the agent-side diff in `agent/src/sync_version.py` but
 * at the file-level granularity the UI cares about, not the chunk level.
 * Two files are "unchanged" iff they have the same ordered chunk-hash
 * sequence — same bytes, same order.
 */

import type { VersionFileEntry } from './chunking';

export interface VersionDiffResult {
  /** In `to` but not `from` — roll-forward would create these. */
  added: VersionFileEntry[];
  /** In `from` but not `to` — roll-forward would delete these. */
  removed: VersionFileEntry[];
  /** Same path, different chunk sequence — content changed. */
  changed: Array<{
    path: string;
    from: VersionFileEntry;
    to: VersionFileEntry;
  }>;
  /** Same path AND identical chunk sequence. Returned for summary stats. */
  unchanged: VersionFileEntry[];
}

/**
 * Diff file lists between two versions. `from` is the current / live
 * version; `to` is the target (for rollback: an older version).
 * "Added" means it exists in `to` but not `from` — i.e., after the
 * rollback completes, this file will appear on the agents.
 */
export function diffVersions(
  from: readonly VersionFileEntry[],
  to: readonly VersionFileEntry[],
): VersionDiffResult {
  const fromByPath = new Map<string, VersionFileEntry>();
  for (const f of from) fromByPath.set(f.path, f);

  const toByPath = new Map<string, VersionFileEntry>();
  for (const f of to) toByPath.set(f.path, f);

  const added: VersionFileEntry[] = [];
  const removed: VersionFileEntry[] = [];
  const changed: VersionDiffResult['changed'] = [];
  const unchanged: VersionFileEntry[] = [];

  // Walk `to`: decide for each target file whether it's new, changed,
  // or unchanged vs the current version.
  for (const toFile of to) {
    const fromFile = fromByPath.get(toFile.path);
    if (!fromFile) {
      added.push(toFile);
      continue;
    }
    if (sameContent(fromFile, toFile)) {
      unchanged.push(toFile);
    } else {
      changed.push({ path: toFile.path, from: fromFile, to: toFile });
    }
  }

  // Walk `from`: any file not present in `to` gets removed by rollforward.
  for (const fromFile of from) {
    if (!toByPath.has(fromFile.path)) {
      removed.push(fromFile);
    }
  }

  // Stable ordering for deterministic UI.
  added.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  removed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  changed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { added, removed, changed, unchanged };
}

/** Two entries have identical content iff their chunk-hash sequences match. */
function sameContent(a: VersionFileEntry, b: VersionFileEntry): boolean {
  if (a.size !== b.size) return false;
  if (a.chunks.length !== b.chunks.length) return false;
  for (let i = 0; i < a.chunks.length; i++) {
    if (a.chunks[i].hash !== b.chunks[i].hash) return false;
  }
  return true;
}

/* --------------------------------------------------------------------- */
/*  Summary for the dialog header                                        */
/* --------------------------------------------------------------------- */

export interface DiffSummary {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  /** Any material change? false = rollback would be a no-op. */
  hasChanges: boolean;
  /**
   * Net byte delta: `to.totalBytes - from.totalBytes`. Positive means the
   * rollback target is larger; negative means smaller. Useful for a quick
   * "you'll reclaim ~2 GB" note in the dialog.
   */
  netBytesDelta: number;
}

export function summariseDiff(
  from: readonly VersionFileEntry[],
  to: readonly VersionFileEntry[],
  diff?: VersionDiffResult,
): DiffSummary {
  const d = diff ?? diffVersions(from, to);
  const fromBytes = from.reduce((n, f) => n + f.size, 0);
  const toBytes = to.reduce((n, f) => n + f.size, 0);
  return {
    added: d.added.length,
    removed: d.removed.length,
    changed: d.changed.length,
    unchanged: d.unchanged.length,
    hasChanges: d.added.length + d.removed.length + d.changed.length > 0,
    netBytesDelta: toBytes - fromBytes,
  };
}

/* --------------------------------------------------------------------- */
/*  Rollout strategy                                                     */
/* --------------------------------------------------------------------- */

export type RolloutStrategy = 'canary' | 'all_at_once';

/**
 * Default strategy: canary. Rolling back all-at-once defeats the point
 * of the canary machinery on the server (wave 2b.3) — a bad rollback
 * still shouldn't hit the fleet simultaneously.
 */
export const DEFAULT_ROLLOUT_STRATEGY: RolloutStrategy = 'canary';
