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

/** Firestore Timestamp (or any `{ toMillis() }`) → epoch ms, else 0. */
function toMillis(value: unknown): number {
  const ts = value as { toMillis?: () => number } | null;
  if (ts && typeof ts.toMillis === 'function') {
    const ms = ts.toMillis();
    return typeof ms === 'number' && Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

/**
 * Age (ms) of the freshest liveness signal on a machine doc, or `null` when
 * none is present. Prefers `metrics.timestamp` (stamped with the metrics
 * themselves); falls back to the top-level `lastHeartbeat` for legacy docs.
 */
export function telemetryAgeMs(
  machineData: Record<string, unknown> | undefined | null,
  now: number,
): number | null {
  if (!machineData) return null;
  const metrics = machineData.metrics as Record<string, unknown> | undefined;
  const metricsTs = toMillis(metrics?.timestamp);
  const heartbeatTs = toMillis(machineData.lastHeartbeat);
  const freshest = Math.max(metricsTs, heartbeatTs);
  return freshest > 0 ? now - freshest : null;
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
