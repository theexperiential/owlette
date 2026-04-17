/**
 * Disk IO monitoring utilities
 *
 * Throughput formatting, chart colors, and key helpers for per-volume
 * disk read/write/busy metrics. Keys use the per-device flattening
 * convention ({volumeId}_io_{channel}, e.g. `C:_io_read`) consistent
 * with per-NIC, per-disk, and per-GPU keys in useHistoricalMetrics.
 */

import { formatThroughput } from './networkUtils';

/** Chart line colors for per-volume disk IO series. */
export const DISK_IO_COLORS = {
  read: 'rgb(74, 222, 128)',   // green - matches NIC RX convention
  write: 'rgb(251, 146, 60)',  // orange - matches NIC TX convention
  busy: 'rgb(168, 85, 247)',   // purple - distinct from disk-usage green
} as const;

/** Format a byte-rate (bytes/sec) as a human-readable throughput string. */
export function formatDiskIO(bytesPerSec: number): string {
  return formatThroughput(bytesPerSec);
}

/** Returns true iff the key matches the per-volume disk IO naming ({volumeId}_io_read|write|busy). */
export function isDiskIOKey(key: string): boolean {
  return /^.+_io_(read|write|busy)$/.test(key);
}

/** Parse a per-volume disk IO key into { id, channel }, or null if the key is not a disk IO key. */
export function parseDiskIOKey(
  key: string,
): { id: string; channel: 'read' | 'write' | 'busy' } | null {
  const match = /^(.+?)_io_(read|write|busy)$/.exec(key);
  return match ? { id: match[1], channel: match[2] as 'read' | 'write' | 'busy' } : null;
}
