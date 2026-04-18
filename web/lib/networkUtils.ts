/**
 * Network monitoring utilities
 *
 * Throughput formatting and color configuration for per-NIC network metrics.
 */

/**
 * Format bytes/sec into a human-readable throughput string.
 * Uses binary units (1 KB = 1024 bytes) consistent with how
 * memory/disk are displayed throughout Owlette.
 */
export function formatThroughput(bytesPerSec: number): string {
  if (bytesPerSec >= 1_073_741_824) return `${(bytesPerSec / 1_073_741_824).toFixed(1)} GB/s`;
  if (bytesPerSec >= 1_048_576) return `${(bytesPerSec / 1_048_576).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${Math.round(bytesPerSec)} B/s`;
}

/**
 * Color pairs for NIC chart lines [TX color, RX color].
 * Each NIC gets a distinct pair to visually separate interfaces.
 */
export const NIC_COLORS: [string, string][] = [
  ['rgb(251, 146, 60)', 'rgb(74, 222, 128)'],    // orange-400 / green-400
  ['rgb(245, 158, 11)', 'rgb(45, 212, 191)'],    // amber-500 / teal-400
  ['rgb(244, 63, 94)', 'rgb(96, 165, 250)'],     // rose-500 / blue-400
];

/**
 * Get the TX/RX color pair for a NIC by index.
 * Wraps around if more NICs than defined color pairs.
 */
export function getNicColors(index: number): { tx: string; rx: string } {
  const pair = NIC_COLORS[index % NIC_COLORS.length];
  return { tx: pair[0], rx: pair[1] };
}

/**
 * Colors for per-device disk usage chart lines.
 * Each physical disk gets a distinct color.
 */
const DISK_COLORS = [
  'oklch(0.72 0.14 155)',  // green (like current disk but per-device)
  'oklch(0.68 0.16 185)',  // teal
  'oklch(0.65 0.14 280)',  // purple
  'oklch(0.70 0.16 85)',   // amber
  'oklch(0.62 0.12 230)',  // slate blue
];

/**
 * Get the color for a disk device by index.
 * Wraps around if more disks than defined colors.
 */
export function getDiskColors(index: number): string {
  return DISK_COLORS[index % DISK_COLORS.length];
}

/**
 * Color pairs for per-GPU chart lines (usage + temperature).
 * Each GPU gets a warm usage color and a cooler temp color.
 */
const GPU_COLORS: { usage: string; temp: string }[] = [
  { usage: 'oklch(0.72 0.19 55)',  temp: 'oklch(0.65 0.22 25)' },   // orange / red-orange
  { usage: 'oklch(0.70 0.18 130)', temp: 'oklch(0.63 0.20 100)' },  // green / yellow-green
  { usage: 'oklch(0.68 0.20 270)', temp: 'oklch(0.60 0.22 300)' },  // purple / magenta
];

/**
 * Get the usage/temp color pair for a GPU by index.
 * Wraps around if more GPUs than defined color pairs.
 */
export function getGpuColors(index: number): { usage: string; temp: string } {
  return GPU_COLORS[index % GPU_COLORS.length];
}

/**
 * Get the primary NIC from an interfaces record (highest combined utilization).
 */
export function getPrimaryNic(
  interfaces: Record<string, { tx_bps: number; rx_bps: number; tx_util: number; rx_util: number; link_speed: number }>
): { name: string; data: typeof interfaces[string] } | null {
  let best: { name: string; data: typeof interfaces[string] } | null = null;
  let bestUtil = -1;

  for (const [name, data] of Object.entries(interfaces)) {
    const util = Math.max(data.tx_util, data.rx_util);
    if (util > bestUtil || (util === bestUtil && (data.tx_bps + data.rx_bps) > ((best?.data.tx_bps ?? 0) + (best?.data.rx_bps ?? 0)))) {
      best = { name, data };
      bestUtil = util;
    }
  }

  return best;
}
