/**
 * Pure pre-upload checks for roost (wave 3.4).
 *
 * The operator has dropped a folder, the version builder has hashed
 * it, and the dashboard needs to answer four questions BEFORE issuing
 * signed URLs and spending bandwidth + quota:
 *
 *   1. How big is this, really? (with dedup preview)
 *   2. How long will it take? (bandwidth estimate)
 *   3. Will it fit on each target machine's disk?
 *   4. Will it fit within the site's storage quota?
 *
 * Only the first is about the data — the other three catch preventable
 * failures that would otherwise surface halfway through the upload as
 * a broken deploy. The component consumes these helpers, renders the
 * warnings, and refuses to start the upload when any `blocking` flag
 * is set.
 */

import type { NamedBlob, VersionFileEntry } from './chunking';
import { summariseVersion } from './chunking';

/* --------------------------------------------------------------------- */
/*  Shared types                                                         */
/* --------------------------------------------------------------------- */

export interface PreUploadTarget {
  machineId: string;
  /** Display name for the warning copy. */
  name: string;
  /** Free disk bytes on the machine, if known. `undefined` = unknown. */
  freeDiskBytes?: number;
}

export interface QuotaSnapshot {
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

/* --------------------------------------------------------------------- */
/*  Size + dedup preview                                                 */
/* --------------------------------------------------------------------- */

export interface SizeSummary {
  fileCount: number;
  totalBytes: number;
  /** Sum of distinct chunk sizes — what actually goes over the wire. */
  uploadBytes: number;
  /** Fraction saved by dedup (0..1). */
  dedupRatio: number;
}

/**
 * Compute what will actually be uploaded after content-addressed dedup
 * inside this version. `uploadBytes` is the byte-weighted sum of
 * distinct chunk hashes — if 100 × 4 MiB chunks all hash the same, we
 * upload one 4 MiB copy, not 400 MiB.
 *
 * Does NOT account for chunks that are already present on the server
 * (that dedup happens via /api/chunks/check at admit time). For that
 * wider dedup, callers pass `alreadyPresent` so we can exclude them
 * from `uploadBytes`.
 */
export function summariseSize(
  entries: readonly VersionFileEntry[],
  alreadyPresent: ReadonlySet<string> = new Set(),
): SizeSummary {
  const summary = summariseVersion(entries);
  // uploadBytes: sum of sizes per distinct chunk hash, minus any already-present.
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
 * Pre-hash sibling of summariseSize for the confirmation screen we show
 * BEFORE chunking + hashing have run. Returns the same SizeSummary shape
 * but with `uploadBytes === totalBytes` (worst case — no dedup yet) and
 * `dedupRatio === 0`. Use this for the "are you sure?" gate; switch to
 * summariseSize once the hashing pass has produced VersionFileEntry[].
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

/* --------------------------------------------------------------------- */
/*  Upload time estimate                                                 */
/* --------------------------------------------------------------------- */

/** Assumed uplink bandwidth when the caller doesn't supply one. */
export const DEFAULT_UPLOAD_MBPS = 50;

/**
 * Estimate wall-clock upload seconds at the given megabits/sec. Caller
 * can derive Mbps from a speedtest or the network information API; we
 * don't measure here — this is a pure conversion.
 *
 * Applies a 30 % overhead fudge for signed-URL issuance latency, TLS
 * handshakes, retries, and server-side finalize. Underestimating time
 * is a worse UX than overestimating.
 */
export function estimateUploadSeconds(
  uploadBytes: number,
  mbps: number = DEFAULT_UPLOAD_MBPS,
): number {
  if (uploadBytes <= 0) return 0;
  const safeMbps = mbps > 0 ? mbps : DEFAULT_UPLOAD_MBPS;
  // 1 MB = 8 megabits. * 1.3 overhead factor.
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

/* --------------------------------------------------------------------- */
/*  Per-target disk check                                                */
/* --------------------------------------------------------------------- */

/**
 * Return one `PreUploadCheck` per target whose disk is either unknown
 * or insufficient. Targets with plenty of room are omitted entirely
 * so the UI doesn't render green checkmarks for every good machine.
 *
 * Insufficient = free disk < totalBytes × (1 + margin). Default margin
 * is 20 % — disks that land exactly at the limit fill up and crash OS
 * operations. Caller can override.
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

/* --------------------------------------------------------------------- */
/*  Quota check                                                          */
/* --------------------------------------------------------------------- */

/**
 * Given the current quota snapshot + the upload size (post-dedup), is
 * there room? Returns an `error`-severity blocking check if the upload
 * would exceed the plan cap, a `warning` advisory if it would cross
 * 80 % of the cap, otherwise nothing.
 */
export function checkQuota(
  uploadBytes: number,
  quota: QuotaSnapshot | undefined,
): PreUploadCheck | null {
  if (!quota) return null;
  if (!isFinite(quota.planLimitBytes)) return null; // unlimited plan

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

/* --------------------------------------------------------------------- */
/*  Roll-up: are we allowed to start?                                    */
/* --------------------------------------------------------------------- */

export function canStartUpload(checks: readonly PreUploadCheck[]): boolean {
  for (const c of checks) if (c.blocking) return false;
  return true;
}

/* --------------------------------------------------------------------- */
/*  Byte formatting                                                      */
/* --------------------------------------------------------------------- */

/** Human-readable bytes, e.g. `"1.2 GB"`, `"350 MB"`, `"450 KB"`. */
export function formatBytes(n: number): string {
  if (!isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  if (n < 1024 ** 4) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${(n / 1024 ** 4).toFixed(2)} TB`;
}
