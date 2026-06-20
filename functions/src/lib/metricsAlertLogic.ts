/**
 * Pure helpers for metric-threshold alert gating.
 *
 * No firebase-admin side effects live here, so these are unit-testable under
 * `node --test` (importing metricsHistory.ts directly would run
 * `admin.firestore()` at module load).
 *
 * Why this exists
 * ---------------
 * `onMetricsWrite` fires on EVERY write to a machine doc, not just fresh agent
 * telemetry. An offline machine keeps its last metrics frozen in the doc, and
 * unrelated server-side writes (e.g. the health-check cron stamping
 * `health.lastCronAlertAt`) re-trigger the function. Without a freshness gate
 * we log phantom history samples AND re-fire threshold alerts on a week-old
 * value — the "disk 87.2% > 85 emailed every hour for a machine that's been
 * offline all week" bug.
 *
 * Both signals we read are SERVER timestamps the agent stamps on each real
 * telemetry write (`metrics.timestamp`, written alongside the metrics, and the
 * top-level `lastHeartbeat`). Server-side writes that aren't telemetry leave
 * them untouched, and because they're server-stamped there's no agent-clock-skew
 * risk in comparing them to the function's `Date.now()`.
 */

/**
 * Telemetry older than this is treated as a dead machine's frozen snapshot —
 * nothing fresh to sample, nothing live to alert on. Deliberately generous
 * relative to the ~120s idle heartbeat cadence so a single delayed write never
 * trips it, while still trivially catching a machine that's been offline for
 * minutes or longer. (The health-check cron's stricter 3-minute OFFLINE
 * threshold governs the separate "machine offline" email; this only governs
 * whether a metrics write is worth sampling/alerting on.)
 */
export const STALE_METRICS_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Firestore Timestamp (or any `{ toMillis() }`) → epoch ms, else 0.
 *
 * CONTRACT (load-bearing): only Timestamp-shaped values are datable. A raw
 * number (epoch ms or seconds) returns 0 here → telemetryAgeMs yields null →
 * isTelemetryStale is true. This fails CLOSED on purpose: the agent only ever
 * writes SERVER_TIMESTAMP (resolved by Firestore to a real Timestamp), so a
 * plain number can only come from a future regression/backfill — and we would
 * rather suppress an undatable value than silently misread seconds-vs-ms and
 * either spam or starve alerts. Tests pin this so the contract break is loud.
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
 * Dates freshness by the metrics timestamp the agent stamps on every real
 * telemetry write (_upload_metrics). WHERE that timestamp lives is subtle: the
 * agent writes the dot-notation key `'metrics.timestamp'`, and its Firestore
 * REST client backtick-escapes any dotted SERVER_TIMESTAMP key
 * (firestore_rest_client.py `_extract_server_timestamps`), so in production it
 * lands in a LITERAL top-level field named "metrics.timestamp" — NOT nested
 * under the metrics map. We read the literal field first, and also accept a
 * genuinely-nested `metrics.timestamp` so this keeps working if the agent
 * storage is ever corrected.
 *
 * Falls back to top-level `lastHeartbeat` ONLY when no metrics timestamp exists
 * (legacy docs). It deliberately does NOT take max-of-both / prefer a fresher
 * heartbeat: the agent's offline-marking write (_update_presence(False))
 * re-stamps `lastHeartbeat` while leaving the metrics (and their timestamp)
 * frozen, so keying on the metrics timestamp — which that write never touches —
 * is what makes a just-gone-offline machine correctly read as stale.
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
 * True when a machine doc's telemetry is too old to sample or alert on. A
 * missing timestamp counts as stale — we never alert on a value we can't date.
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
 * Single ordered, testable gate for `onMetricsWrite`. The ordering is the
 * contract: metrics-PRESENCE is checked BEFORE freshness (a write with no
 * metrics map is skipped regardless of timestamps), and only a fresh,
 * metrics-bearing write is processed. A non-`'process'` result MUST short
 * the caller out BEFORE both history sampling and threshold-alert evaluation —
 * that placement is what stops an offline machine's frozen metrics (re-triggered
 * by unrelated server-side writes) from logging phantom samples or re-firing
 * "disk 87% > 85" hourly. Pure, so the decision is unit-tested without the
 * firebase-admin side effects in metricsHistory.ts.
 */
export function metricsWriteDisposition(
  afterData: Record<string, unknown> | undefined | null,
  now: number,
  staleMs: number = STALE_METRICS_MS,
): MetricsWriteDisposition {
  if (!afterData || !afterData.metrics) return 'skip-no-metrics';
  return isTelemetryStale(afterData, now, staleMs) ? 'skip-stale' : 'process';
}
