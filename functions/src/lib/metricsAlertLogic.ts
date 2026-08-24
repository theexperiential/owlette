/**
 * Pure helpers for metric-threshold alert gating. No firebase-admin side effects, so these
 * are unit-testable under `node --test` (importing metricsHistory.ts directly would run
 * `getFirestore()` at module load).
 *
 * `onMetricsWrite` fires on EVERY machine-doc write, not just fresh telemetry: an offline
 * machine keeps its last metrics frozen, and unrelated server writes (the health-check
 * cron stamping `health.lastCronAlertAt`) re-trigger it. Without a freshness gate that
 * means phantom history samples plus "disk 87.2% > 85" emailed hourly for a machine
 * offline all week. Both signals (`metrics.timestamp`, `lastHeartbeat`) are SERVER
 * timestamps written only on real telemetry, so comparing to Date.now() has no skew risk.
 */

/**
 * Telemetry older than this is a dead machine's frozen snapshot — nothing to sample or
 * alert on. Generous next to the ~120s idle heartbeat so a single delayed write can't
 * trip it. (The health cron's stricter 3-minute OFFLINE threshold drives the offline
 * email; this only gates whether a metrics write is worth sampling/alerting on.)
 */
export const STALE_METRICS_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Firestore Timestamp (or any `{ toMillis() }`) → epoch ms, else 0.
 *
 * CONTRACT (load-bearing): only Timestamp-shaped values are datable. A raw number returns
 * 0 → telemetryAgeMs null → isTelemetryStale true. Fails CLOSED on purpose: the agent only
 * writes SERVER_TIMESTAMP, so a plain number can only come from a regression/backfill, and
 * suppressing an undatable value beats misreading seconds-vs-ms. Tests pin this.
 */
function toMillis(value: unknown): number {
  const ts = value as { toMillis?: () => number } | null;
  if (ts && typeof ts.toMillis === 'function') {
    const ms = ts.toMillis();
    return typeof ms === 'number' && Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

/**
 * Age (ms) of the metrics on a machine doc, or `null` when undatable.
 *
 * WHERE the timestamp lives is subtle: the agent writes the dot-notation key
 * `'metrics.timestamp'`, and its REST client backtick-escapes dotted SERVER_TIMESTAMP keys
 * (firestore_rest_client.py `_extract_server_timestamps`), so in production it lands in a
 * LITERAL top-level field "metrics.timestamp", NOT nested under the metrics map. We read
 * the literal first, and also accept a nested value if the agent is ever corrected.
 *
 * Falls back to `lastHeartbeat` ONLY when no metrics timestamp exists (legacy docs), never
 * max-of-both: the agent's offline write (_update_presence(False)) re-stamps lastHeartbeat
 * while leaving the metrics frozen, so keying on the metrics timestamp is what makes a
 * just-gone-offline machine correctly read as stale.
 */
export function telemetryAgeMs(
  machineData: Record<string, unknown> | undefined | null,
  now: number,
): number | null {
  if (!machineData) return null;
  const metrics = machineData.metrics as Record<string, unknown> | undefined;
  const metricsTs =
    toMillis(machineData['metrics.timestamp']) || toMillis(metrics?.timestamp);
  const signal = metricsTs > 0 ? metricsTs : toMillis(machineData.lastHeartbeat);
  return signal > 0 ? now - signal : null;
}

/**
 * True when a machine doc's telemetry is too old to sample or alert on. A missing
 * timestamp counts as stale — never alert on a value we can't date.
 */
export function isTelemetryStale(
  machineData: Record<string, unknown> | undefined | null,
  now: number,
  staleMs: number = STALE_METRICS_MS,
): boolean {
  const age = telemetryAgeMs(machineData, now);
  return age === null || age > staleMs;
}

/** What `onMetricsWrite` should do with a given machine-doc write. */
export type MetricsWriteDisposition = 'process' | 'skip-no-metrics' | 'skip-stale';

/**
 * Single ordered, testable gate for `onMetricsWrite`. The ordering is the contract:
 * metrics-PRESENCE before freshness (a write with no metrics map is skipped regardless of
 * timestamps), and only a fresh metrics-bearing write is processed. A non-`'process'`
 * result MUST short the caller out BEFORE both history sampling and threshold evaluation —
 * that placement is what stops an offline machine's frozen metrics from logging phantom
 * samples or re-firing "disk 87% > 85" hourly.
 */
export function metricsWriteDisposition(
  afterData: Record<string, unknown> | undefined | null,
  now: number,
  staleMs: number = STALE_METRICS_MS,
): MetricsWriteDisposition {
  if (!afterData || !afterData.metrics) return 'skip-no-metrics';
  return isTelemetryStale(afterData, now, staleMs) ? 'skip-stale' : 'process';
}
