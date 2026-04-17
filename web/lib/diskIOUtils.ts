/**
 * Disk IO monitoring utilities
 *
 * Throughput formatting, chart colors, and key helpers for aggregate
 * disk read/write/busy metrics. Keys use the flat-naming convention
 * (diskIO_read / diskIO_write / diskIO_busy) consistent with the
 * per-NIC, per-disk, and per-GPU flattening in useHistoricalMetrics.
 */

import { formatThroughput } from './networkUtils';

/** Chart line colors for aggregate disk IO series. */
export const DISK_IO_COLORS = {
  read: 'rgb(74, 222, 128)',   // green - matches NIC RX convention
  write: 'rgb(251, 146, 60)',  // orange - matches NIC TX convention
  busy: 'rgb(168, 85, 247)',   // purple - distinct from disk-usage green
} as const;

/** Format a byte-rate (bytes/sec) as a human-readable throughput string. */
export function formatDiskIO(bytesPerSec: number): string {
  return formatThroughput(bytesPerSec);
}

/** Returns true iff the key matches the flat disk IO naming (diskIO_read|write|busy). */
export function isDiskIOKey(key: string): boolean {
  return /^diskIO_(read|write|busy)$/.test(key);
}

/** Parse a flat disk IO key into its suffix, or null if the key is not a disk IO key. */
export function parseDiskIOKey(key: string): 'read' | 'write' | 'busy' | null {
  const match = /^diskIO_(read|write|busy)$/.exec(key);
  return match ? (match[1] as 'read' | 'write' | 'busy') : null;
}
