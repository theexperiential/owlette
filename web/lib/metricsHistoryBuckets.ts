/**
 * metrics_history bucket-id contract — SINGLE SOURCE OF TRUTH for readers.
 *
 * `sites/{siteId}/machines/{machineId}/metrics_history/{bucketId}`, two shapes,
 * both keyed off the sample's UTC time: hourly `YYYY-MM-DD-HH` (current data) and
 * daily `YYYY-MM-DD` (legacy buckets + e2e fixtures).
 *
 * MUST stay byte-for-byte identical to the writer, `hourlyBucketId` /
 * `dailyBucketId` in `functions/src/metricsHistory.ts`. Every reader imports from
 * here — writer/reader drift is what blanked the inline sparklines once already.
 *
 * `toISOString()` is UTC, so these are locale-independent.
 */

/** `YYYY-MM-DD-HH` (hourly UTC bucket). Mirrors metricsHistory.ts hourlyBucketId. */
export function formatHourBucketId(date: Date): string {
  return date.toISOString().slice(0, 13).replace('T', '-');
}

/** `YYYY-MM-DD` (legacy daily bucket / e2e fixture). Mirrors metricsHistory.ts dailyBucketId. */
export function formatDayBucketId(date: Date): string {
  return date.toISOString().split('T')[0];
}

/** Matches a daily bucket doc id (`YYYY-MM-DD`). */
export const DAY_BUCKET_ID_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Matches an hourly bucket doc id (`YYYY-MM-DD-HH`). */
export const HOUR_BUCKET_ID_RE = /^\d{4}-\d{2}-\d{2}-\d{2}$/;
