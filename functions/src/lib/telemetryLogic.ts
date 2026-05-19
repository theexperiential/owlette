/**
 * Pure logic for roost telemetry + per-tenant cost attribution (wave 2b.6).
 *
 * Cost model (Cloudflare R2, as of 2025-Q4 public pricing):
 *   - Storage         : $0.015 per GB-month
 *   - Class A (writes): $4.50 per million
 *   - Class B (reads) : $0.36 per million
 *   - Egress          : $0 (R2's signature — free egress is the whole
 *                       reason roost picked R2 over S3/GCS).
 *
 * Costs are pro-rated for the fraction of the billing month that has
 * elapsed so the dashboard can show "$X so far this month" at any time.
 *
 * Cost math is split from the handler so it's unit-testable and so the
 * dashboard can recompute projections client-side if it ever needs to
 * show what-if-you-kept-growing scenarios.
 */

/* --------------------------------------------------------------------- */
/*  Pricing constants                                                    */
/* --------------------------------------------------------------------- */

/** R2 storage rate, USD per GB-month. Authoritative: Cloudflare docs 2025. */
export const R2_STORAGE_USD_PER_GB_MONTH = 0.015;

/** R2 class-A (PUT / POST / LIST) rate, USD per million ops. */
export const R2_CLASS_A_USD_PER_M = 4.5;

/** R2 class-B (GET / HEAD) rate, USD per million ops. */
export const R2_CLASS_B_USD_PER_M = 0.36;

/** R2 egress is free; constant present for symmetry + future fee changes. */
export const R2_EGRESS_USD_PER_GB = 0;

const BYTES_PER_GB = 1024 ** 3;

/* --------------------------------------------------------------------- */
/*  Types                                                                */
/* --------------------------------------------------------------------- */

/**
 * Per-tenant raw observations for a billing window. All counters are
 * cumulative within the window (not delta-since-last-poll).
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
   * Fraction of the billing month elapsed (0 < f ≤ 1). Storage cost is
   * pro-rated by this fraction because it's billed per GB-month. Ops
   * are NOT pro-rated — they're counted at the time they happen.
   */
  monthFractionElapsed: number;
}

/* --------------------------------------------------------------------- */
/*  Cost math                                                            */
/* --------------------------------------------------------------------- */

/**
 * Compute the USD cost of a tenant's R2 activity for the window.
 *
 * Storage is pro-rated by `monthFractionElapsed`; ops and egress are not
 * (they accrue point-in-time). Rounding is left to the caller.
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

/**
 * Return the fraction of the calendar month already elapsed at `now`.
 * For March 15 at noon: roughly 14.5 / 31 ≈ 0.47.
 */
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

/* --------------------------------------------------------------------- */
/*  Event types + aggregation                                            */
/* --------------------------------------------------------------------- */

/**
 * Usage events are emitted by the web + agent sides whenever a billable
 * R2 operation completes. Aggregator rolls these up nightly into
 * `UsageCounters` per site.
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
 * Fold a list of events for one site into `UsageCounters`.
 *
 * `storageBytes` is the AVERAGE of storage_snapshot observations (not
 * the latest) because R2 bills on stored bytes over time. A tenant who
 * had 100 GB for 1 hour and then deleted to 1 GB for 23 hours should
 * pay for ~5 GB-day, not 100.
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

/* --------------------------------------------------------------------- */
/*  OTLP log payload                                                     */
/* --------------------------------------------------------------------- */

/**
 * Shape of a single telemetry log record. Intentionally OTLP-compatible
 * so a Cloud Logging → OpenTelemetry collector sidecar can forward it
 * without field-name translation.
 *
 * This is the "exporter" surface for now: emit JSON-line records on
 * stderr. Switching to a proper OTEL SDK exporter later is a drop-in
 * for this function.
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
