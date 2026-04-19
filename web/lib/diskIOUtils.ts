/**
 * Disk IO monitoring utilities
 *
 * Throughput formatting, chart colors, and key helpers for per-volume disk
 * activity metrics. Chart keys use the per-device flattening convention
 * ({volumeId}_io_{channel}, e.g. `C:_io_read_pct`) consistent with per-NIC,
 * per-disk, and per-GPU keys in useHistoricalMetrics. Read/write are emitted
 * as percent-of-max-bandwidth so the chart shares the 0-100 axis with the
 * other metrics; the agent ships a hardware-class maxBps estimate per
 * volume that ratchets up on observed peaks.
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

/** Returns true iff the key matches the per-volume disk IO activity naming ({volumeId}_io_read_pct|write_pct). */
export function isDiskIOKey(key: string): boolean {
  return /^.+_io_(read|write)_pct$/.test(key);
}

/** Parse a per-volume disk IO activity key into { id, channel }, or null if the key is not a disk IO activity key. */
export function parseDiskIOKey(
  key: string,
): { id: string; channel: 'read' | 'write' } | null {
  const match = /^(.+?)_io_(read|write)_pct$/.exec(key);
  return match ? { id: match[1], channel: match[2] as 'read' | 'write' } : null;
}
