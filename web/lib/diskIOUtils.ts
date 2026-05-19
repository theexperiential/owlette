/**
 * Disk IO monitoring utilities
 *
 * Throughput formatting, chart colors, and key helpers for per-volume disk
 * activity metrics. Chart data carries two parallel key families per channel
 * ({volumeId}_io_{channel} for raw bytes/sec, {volumeId}_io_{channel}_pct for
 * percent-of-max-bandwidth); `isDiskIOKey` / `parseDiskIOKey` accept both.
 * The MetricsDetailPanel picks which family to bind to a visible chart line
 * at render time: percent mode (default 0-100 axis) when a volume is running
 * near max bandwidth so users can see saturation, and bytes mode (auto-scaled
 * right axis with KB/MB/GB ticks) when activity is far below max so the line
 * stays readable instead of flatlining near zero.
 */

import { formatThroughput } from './networkUtils';

/** Chart line colors for per-volume disk IO activity series. */
export const DISK_IO_COLORS = {
  read: 'rgb(74, 222, 128)',   // green - matches NIC RX convention
  write: 'rgb(251, 146, 60)',  // orange - matches NIC TX convention
} as const;

/** Format a byte-rate (bytes/sec) as a human-readable throughput string. */
export function formatDiskIO(bytesPerSec: number): string {
  return formatThroughput(bytesPerSec);
}

/** Returns true iff the key matches the per-volume disk IO naming — either the
 *  bytes variant ({volumeId}_io_read|write) or the percent variant
 *  ({volumeId}_io_read|write_pct). `_io_busy` and unknown channels are rejected. */
export function isDiskIOKey(key: string): boolean {
  return /^.+_io_(read|write)(_pct)?$/.test(key);
}

/** Parse a per-volume disk IO key into { id, channel, isPct }, or null if the
 *  key doesn't match the disk-IO naming. `isPct` distinguishes the %-of-max
 *  chart-line variant from the raw bytes/sec variant so callers can pick the
 *  right rendering branch. */
export function parseDiskIOKey(
  key: string,
): { id: string; channel: 'read' | 'write'; isPct: boolean } | null {
  const match = /^(.+?)_io_(read|write)(_pct)?$/.exec(key);
  return match
    ? {
        id: match[1],
        channel: match[2] as 'read' | 'write',
        isPct: match[3] === '_pct',
      }
    : null;
}

/** Compute round-number Y-axis ticks for a bytes/sec chart. Recharts' auto
 *  tick picker divides the observed max by 4 and lands on values like
 *  "585.9 KB/s" that don't match any unit boundary users recognise. This
 *  picks a step from nice mantissas × binary bases (1, 1024, 1024², 1024³) so
 *  every tick formats cleanly via formatThroughput — 250 KB/s, 500 KB/s,
 *  1 MB/s, etc. Returns null for non-positive max so callers fall through to
 *  recharts' default scale (e.g. empty/all-zero charts). */
export function computeNiceByteTicks(
  maxBytesPerSec: number,
): { domainMax: number; ticks: number[] } | null {
  if (!Number.isFinite(maxBytesPerSec) || maxBytesPerSec <= 0) return null;

  // Nice decimal mantissas × binary bases. The mantissas that divide cleanly
  // into 1024 (e.g. 256, 512) aren't here by design — "250 KB", "500 KB",
  // "1 MB" are what humans expect, even though 250 × 1024 = 256 000 bytes.
  const mantissas = [1, 2, 5, 10, 25, 50, 100, 250, 500];
  const bases = [1, 1024, 1024 * 1024, 1024 * 1024 * 1024];

  // Aim for ~4 intervals between 0 and niceMax, so pick the smallest
  // candidate ≥ max/4.
  const rough = maxBytesPerSec / 4;
  let step = 0;
  outer: for (const base of bases) {
    for (const m of mantissas) {
      const s = m * base;
      if (s >= rough) {
        step = s;
        break outer;
      }
    }
  }
  // Max beyond 500 GB/s — rare but keep the axis sane by capping at the
  // largest candidate rather than bailing out.
  if (step === 0) step = mantissas[mantissas.length - 1] * bases[bases.length - 1];

  const domainMax = Math.ceil(maxBytesPerSec / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= domainMax; v += step) ticks.push(v);
  return { domainMax, ticks };
}
