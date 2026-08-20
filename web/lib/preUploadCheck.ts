/**
 * Pure pre-upload checks for roost: size (with dedup preview), duration
 * estimate, per-machine disk, and site quota — answered BEFORE signed URLs are
 * issued, so preventable failures don't surface mid-upload as a broken deploy.
 * Callers refuse to start when any check is `blocking`.
 */

import type { NamedBlob, VersionFileEntry } from './chunking';
import { summariseVersion } from './chunking';

export interface PreUploadTarget {
  machineId: string;
  /** Display name for the warning copy. */
  name: string;
  /** Free disk bytes on the machine, if known. `undefined` = unknown. */
  freeDiskBytes?: number;
}

export interface QuotaSnapshot {
  /** Included storage for the site's tier, in bytes. `0` on core. */
  planLimitBytes: number;
  usedBytes: number;
  pendingBytes: number;
}

export interface PreUploadCheck {
  /** Machine-readable flag consumed by the confirm button. */
  blocking: boolean;
  /** Concise human copy for the warning row. */
  message: string;
  /** `warning` for advisory, `error` for blocking. */
  severity: 'warning' | 'error';
}

export interface SizeSummary {
  fileCount: number;
  totalBytes: number;
  /** Sum of distinct chunk sizes — what actually goes over the wire. */
  uploadBytes: number;
  /** Fraction saved by dedup (0..1). */
  dedupRatio: number;
}

/**
 * What actually goes over the wire after in-version dedup: `uploadBytes` sums
 * DISTINCT chunk hashes. Server-side dedup (/api/chunks/check at admit time)
 * is not known here — pass `alreadyPresent` to exclude those hashes.
 */
export function summariseSize(
  entries: readonly VersionFileEntry[],
  alreadyPresent: ReadonlySet<string> = new Set(),
): SizeSummary {
  const summary = summariseVersion(entries);
  const seen = new Map<string, number>();
  for (const entry of entries) {
    for (const c of entry.chunks) {
      if (!seen.has(c.hash)) seen.set(c.hash, c.size);
    }
  }
  let uploadBytes = 0;
  for (const [hash, size] of seen) {
    if (!alreadyPresent.has(hash)) uploadBytes += size;
  }
  const dedupRatio = summary.totalBytes > 0
    ? 1 - uploadBytes / summary.totalBytes
    : 0;
  return {
    fileCount: summary.fileCount,
    totalBytes: summary.totalBytes,
    uploadBytes,
    dedupRatio,
  };
}

/**
 * Pre-hash sibling for the "are you sure?" gate: worst case, so
 * `uploadBytes === totalBytes` and `dedupRatio === 0`. Switch to
 * `summariseSize` once hashing has produced VersionFileEntry[].
 */
export function summariseRawFiles(
  files: readonly NamedBlob[],
): SizeSummary {
  let totalBytes = 0;
  for (const f of files) totalBytes += f.blob.size;
  return {
    fileCount: files.length,
    totalBytes,
    uploadBytes: totalBytes,
    dedupRatio: 0,
  };
}

/** Assumed uplink bandwidth when the caller doesn't supply one. */
export const DEFAULT_UPLOAD_MBPS = 50;

/**
 * Wall-clock seconds at `mbps` (pure conversion — nothing is measured here).
 * Includes a 30% overhead fudge for URL issuance, TLS, retries and finalize;
 * over-estimating reads better than under-estimating.
 */
export function estimateUploadSeconds(
  uploadBytes: number,
  mbps: number = DEFAULT_UPLOAD_MBPS,
): number {
  if (uploadBytes <= 0) return 0;
  const safeMbps = mbps > 0 ? mbps : DEFAULT_UPLOAD_MBPS;
  // bytes → megabits, ×1.3 overhead.
  const seconds = ((uploadBytes * 8) / (safeMbps * 1_000_000)) * 1.3;
  return Math.max(1, Math.round(seconds));
}

/** Format seconds as a human string: "12 seconds", "3 min", "1.5 hrs". */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} sec`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  const hrs = seconds / 3600;
  return `${hrs < 10 ? hrs.toFixed(1) : Math.round(hrs)} hr`;
}

/**
 * One check per target whose disk is unknown or insufficient; healthy targets
 * are omitted rather than rendered as green rows. Insufficient = free <
 * totalBytes × (1 + margin); the 20% default keeps a disk off its own limit.
 */
export function checkTargetDisks(
  targets: readonly PreUploadTarget[],
  totalBytes: number,
  margin: number = 0.2,
): PreUploadCheck[] {
  const results: PreUploadCheck[] = [];
  const required = totalBytes * (1 + margin);
  for (const t of targets) {
    if (t.freeDiskBytes === undefined) {
      results.push({
        blocking: false,
        severity: 'warning',
        message: `free disk on ${t.name} is unknown — upload may still fail if disk is full`,
      });
      continue;
    }
    if (t.freeDiskBytes < required) {
      results.push({
        blocking: true,
        severity: 'error',
        message:
          `${t.name} has ${formatBytes(t.freeDiskBytes)} free — ` +
          `roost needs at least ${formatBytes(required)} ` +
          `(content + ${Math.round(margin * 100)}% margin)`,
      });
    }
  }
  return results;
}

/**
 * Room for a post-dedup upload? Blocking `error` when it would exceed the plan
 * cap, advisory `warning` past 80% of it, otherwise null.
 */
export function checkQuota(
  uploadBytes: number,
  quota: QuotaSnapshot | undefined,
): PreUploadCheck | null {
  if (!quota) return null;

  const afterBytes = quota.usedBytes + quota.pendingBytes + uploadBytes;
  if (afterBytes > quota.planLimitBytes) {
    const needed = afterBytes - quota.planLimitBytes;
    return {
      blocking: true,
      severity: 'error',
      message:
        `upload would exceed the site's plan by ${formatBytes(needed)}. ` +
        `upgrade the plan or delete older content to proceed`,
    };
  }

  const warnThreshold = quota.planLimitBytes * 0.8;
  if (afterBytes > warnThreshold) {
    return {
      blocking: false,
      severity: 'warning',
      message:
        `this upload will put the site above 80% of its plan ` +
        `(${formatBytes(afterBytes)} / ${formatBytes(quota.planLimitBytes)})`,
    };
  }
  return null;
}

export function canStartUpload(checks: readonly PreUploadCheck[]): boolean {
  for (const c of checks) if (c.blocking) return false;
  return true;
}

/** Human-readable bytes, e.g. `"1.2 GB"`, `"350 MB"`, `"450 KB"`. */
export function formatBytes(n: number): string {
  if (!isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  if (n < 1024 ** 4) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${(n / 1024 ** 4).toFixed(2)} TB`;
}
