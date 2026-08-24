/**
 * Pure logic for roost telemetry + per-tenant cost attribution.
 *
 * Cloudflare R2 pricing as of 2025-Q4; free egress is why roost picked R2 over
 * S3/GCS. Storage is pro-rated by elapsed month so the dashboard can show
 * "$X so far this month" at any time. Split from the handler so it's
 * unit-testable and the dashboard can recompute projections client-side.
 */

/** R2 storage rate, USD per GB-month. Authoritative: Cloudflare docs 2025. */
export const R2_STORAGE_USD_PER_GB_MONTH = 0.015;

/** R2 class-A (PUT / POST / LIST) rate, USD per million ops. */
export const R2_CLASS_A_USD_PER_M = 4.5;

/** R2 class-B (GET / HEAD) rate, USD per million ops. */
export const R2_CLASS_B_USD_PER_M = 0.36;

/** R2 egress is free; constant present for symmetry + future fee changes. */
export const R2_EGRESS_USD_PER_GB = 0;

const BYTES_PER_GB = 1024 ** 3;

/**
 * Per-tenant observations for a billing window. Counters are cumulative within
 * the window, not delta-since-last-poll.
 */
export interface UsageCounters {
  /** Peak or averaged storage usage across the window. */
  storageBytes: number;
  /** Class-A ops (PUT/POST/LIST/COPY) during the window. */
  classAOps: number;
  /** Class-B ops (GET/HEAD) during the window. */
  classBOps: number;
  /** Egress bytes during the window. R2 = $0, tracked for analytics. */
  egressBytes: number;
}

export interface CostBreakdown {
  /** Dollar figure, pre-rounding (JS number; dashboard formats to 2dp). */
  storageUsd: number;
  classAUsd: number;
  classBUsd: number;
  egressUsd: number;
  /** Sum of the four lines — the number you'd show on an invoice. */
  totalUsd: number;
}

export interface CostInput {
  counters: UsageCounters;
  /**
   * Fraction of the billing month elapsed (0 < f <= 1). Pro-rates storage only
   * — ops accrue at the moment they happen.
   */
  monthFractionElapsed: number;
}

/**
 * USD cost of a tenant's R2 activity for the window. Storage is pro-rated by
 * `monthFractionElapsed`; ops and egress are not. Rounding is the caller's.
 */
export function computeCost(input: CostInput): CostBreakdown {
  const { counters, monthFractionElapsed } = input;

  const storageGB = counters.storageBytes / BYTES_PER_GB;
  const storageUsd =
    storageGB * R2_STORAGE_USD_PER_GB_MONTH * clamp01(monthFractionElapsed);

  const classAUsd = (counters.classAOps / 1_000_000) * R2_CLASS_A_USD_PER_M;
  const classBUsd = (counters.classBOps / 1_000_000) * R2_CLASS_B_USD_PER_M;

  const egressGB = counters.egressBytes / BYTES_PER_GB;
  const egressUsd = egressGB * R2_EGRESS_USD_PER_GB;

  return {
    storageUsd,
    classAUsd,
    classBUsd,
    egressUsd,
    totalUsd: storageUsd + classAUsd + classBUsd + egressUsd,
  };
}

/** Fraction of the calendar month elapsed at `now` (Mar 15 noon ~= 14.5/31). */
export function monthFractionElapsed(now: Date): number {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const monthStart = Date.UTC(year, month, 1);
  const nextMonthStart = Date.UTC(year, month + 1, 1);
  const elapsedMs = now.getTime() - monthStart;
  const totalMs = nextMonthStart - monthStart;
  return clamp01(elapsedMs / totalMs);
}

function clamp01(x: number): number {
  if (!isFinite(x) || x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Emitted by web + agent whenever a billable R2 operation completes; rolled up
 * nightly into per-site `UsageCounters`.
 */
export type UsageEventKind =
  | 'class_a_op'        // PUT, POST, LIST, COPY
  | 'class_b_op'        // GET, HEAD
  | 'egress'            // bytes leaving R2 (GET response body size)
  | 'storage_snapshot'; // observed total storage bytes at observation time

export interface UsageEvent {
  siteId: string;
  kind: UsageEventKind;
  /** For ops events: count (typically 1 per emission). Ignored for snapshots. */
  count?: number;
  /** For egress: response bytes. For snapshots: total storage bytes. */
  bytes?: number;
  timestamp: number; // unix ms
}

/**
 * Fold one site's events into `UsageCounters`. `storageBytes` averages the
 * storage_snapshot observations rather than taking the latest, because R2 bills
 * stored bytes over time: 100 GB for 1h then 1 GB for 23h is ~5 GB-day, not 100.
 */
export function aggregateCounters(events: readonly UsageEvent[]): UsageCounters {
  let classAOps = 0;
  let classBOps = 0;
  let egressBytes = 0;
  let storageTotal = 0;
  let storageSamples = 0;

  for (const e of events) {
    switch (e.kind) {
      case 'class_a_op':
        classAOps += e.count ?? 1;
        break;
      case 'class_b_op':
        classBOps += e.count ?? 1;
        break;
      case 'egress':
        egressBytes += e.bytes ?? 0;
        break;
      case 'storage_snapshot':
        storageTotal += e.bytes ?? 0;
        storageSamples += 1;
        break;
    }
  }

  const storageBytes = storageSamples > 0 ? storageTotal / storageSamples : 0;
  return { storageBytes, classAOps, classBOps, egressBytes };
}

/**
 * One telemetry log record. OTLP-compatible on purpose, so a Cloud Logging ->
 * OpenTelemetry collector sidecar forwards it without renaming fields. The
 * current exporter just writes JSON lines to stderr; a real OTEL SDK exporter
 * is a drop-in replacement.
 */
export interface OtlpTelemetryRecord {
  /** OTLP severity: INFO, WARN, ERROR. */
  severity: 'INFO' | 'WARN' | 'ERROR';
  /** Stable event name — maps to OTLP `name` attribute. */
  name: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Tenant the record applies to. */
  siteId: string;
  /** Arbitrary key/value attributes — OTLP `attributes`. */
  attributes: Record<string, string | number | boolean>;
}

export function buildUsageRecord(
  siteId: string,
  counters: UsageCounters,
  cost: CostBreakdown,
  now: Date = new Date(),
): OtlpTelemetryRecord {
  return {
    severity: 'INFO',
    name: 'roost.usage.daily',
    timestamp: now.toISOString(),
    siteId,
    attributes: {
      'tenant.id': siteId,
      'usage.storage_bytes': counters.storageBytes,
      'usage.class_a_ops': counters.classAOps,
      'usage.class_b_ops': counters.classBOps,
      'usage.egress_bytes': counters.egressBytes,
      'cost.storage_usd': cost.storageUsd,
      'cost.class_a_usd': cost.classAUsd,
      'cost.class_b_usd': cost.classBUsd,
      'cost.egress_usd': cost.egressUsd,
      'cost.total_usd': cost.totalUsd,
    },
  };
}

export function buildEmptyRecord(
  siteId: string,
  reason: string,
  now: Date = new Date(),
): OtlpTelemetryRecord {
  return {
    severity: 'INFO',
    name: 'roost.usage.skipped',
    timestamp: now.toISOString(),
    siteId,
    attributes: { reason },
  };
}
