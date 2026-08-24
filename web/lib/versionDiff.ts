/**
 * Pure version diff for the roost rollback dialog: partition `from` (live) and
 * `to` (target) into add/remove/change/unchanged so the operator sees what will
 * happen before flipping the pointer.
 *
 * Mirrors `agent/src/sync_version.py` but at FILE granularity, not chunk.
 * Unchanged iff the ordered chunk-hash sequence matches.
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
 * Diff two versions' file lists. `from` is live, `to` is the target — so "added"
 * means the file appears on the agents once the rollback completes.
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

  // Anything not in `to` gets removed.
  for (const fromFile of from) {
    if (!toByPath.has(fromFile.path)) {
      removed.push(fromFile);
    }
  }

  // Deterministic UI ordering.
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

export interface DiffSummary {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  /** Any material change? false = rollback would be a no-op. */
  hasChanges: boolean;
  /** `to` bytes minus `from` bytes; negative means the rollback reclaims space. */
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

export type RolloutStrategy = 'canary' | 'all_at_once';

/** Canary by default — a bad rollback must not hit the whole fleet at once. */
export const DEFAULT_ROLLOUT_STRATEGY: RolloutStrategy = 'canary';
