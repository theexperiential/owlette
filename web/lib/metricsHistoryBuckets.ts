/**
 * metrics_history bucket-id contract (single source of truth)
 *
 * Time-series metrics live in `sites/{siteId}/machines/{machineId}/metrics_history/{bucketId}`.
 * There are two bucket shapes, both keyed off the sample's UTC time:
 *   - hourly: `YYYY-MM-DD-HH` — written by the cloud function for all current data
 *   - daily:  `YYYY-MM-DD`    — legacy buckets + the e2e screenshot fixtures
 *
 * The writer is `functions/src/metricsHistory.ts` (`hourlyBucketId` / `dailyBucketId`);
 * these formatters MUST stay byte-for-byte identical to it. Every reader
 * (useSparklineData, useHistoricalMetrics) imports from here so the contract
 * can't drift per-file again — drift between writer and one reader is exactly
 * what blanked the inline sparklines once before.
 *
 * `toISOString()` is always UTC and starts `YYYY-MM-DDTHH:...`, so these are
 * timezone-independent and match the writer regardless of server locale.
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
