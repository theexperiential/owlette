/**
 * Telemetry pipeline + per-tenant cost attribution (roost wave 2b.6).
 *
 * Three entrypoints:
 *
 *   recordUsageEvent    — HTTPS callable. Callers (the upload API, chunk
 *                          verify, etc.) POST a UsageEvent describing a
 *                          billable R2 operation. We write it to the
 *                          per-site events subcollection; the aggregator
 *                          rolls it up nightly.
 *
 *   aggregateTelemetry  — scheduled daily 04:30 UTC. For each site,
 *                          read the events for the window, fold into
 *                          UsageCounters, compute cost, write a daily
 *                          rollup doc + emit an OTLP log record.
 *
 *   getUsageSummary     — HTTPS callable. Dashboard fetches current-month
 *                          counters + projected cost for a site.
 *
 * **Exporter note**: OTLP records are emitted as structured JSON on
 * stderr (`console.error` in GCP wraps it to Cloud Logging with full
 * severity + jsonPayload support). A Cloud Logging → OpenTelemetry
 * collector sidecar then forwards to the eventual OTLP backend. Full
 * OTEL SDK auto-instrumentation is deferred to wave 0.6 where the
 * collector is stood up.
 */

import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import {
  aggregateCounters,
  buildEmptyRecord,
  buildUsageRecord,
  computeCost,
  monthFractionElapsed,
  type CostBreakdown,
  type OtlpTelemetryRecord,
  type UsageCounters,
  type UsageEvent,
  type UsageEventKind,
} from './lib/telemetryLogic';

/* --------------------------------------------------------------------- */
/*  Dependency interfaces                                                */
/* --------------------------------------------------------------------- */

export interface EventStore {
  /** Persist a raw usage event. Called by `recordUsageEvent`. */
  append(event: UsageEvent): Promise<void>;
  /**
   * Return all events for `siteId` in `[startMs, endMs)` window.
   * Aggregator iterates this in daily windows.
   */
  readWindow(
    siteId: string,
    startMs: number,
    endMs: number,
  ): Promise<UsageEvent[]>;
  /** Delete events older than `cutoffMs` so the collection doesn't grow forever. */
  trimOlderThan(siteId: string, cutoffMs: number): Promise<number>;
}

export interface SummaryStore {
  /** Write a daily rollup + update the month-to-date running total. */
  writeDailyRollup(
    siteId: string,
    dayIso: string, // '2026-04-19'
    counters: UsageCounters,
    cost: CostBreakdown,
  ): Promise<void>;
  /** Fetch the current month-to-date summary for the dashboard. */
  readMonthToDate(
    siteId: string,
    yyyyMm: string, // '2026-04'
  ): Promise<{ counters: UsageCounters; cost: CostBreakdown } | null>;
}

export interface SiteDirectory {
  listSiteIds(): Promise<string[]>;
}

export type OtlpExporter = (record: OtlpTelemetryRecord) => void;

/* --------------------------------------------------------------------- */
/*  Pure orchestrator — event recording                                  */
/* --------------------------------------------------------------------- */

export interface RecordEventDeps {
  store: EventStore;
  now?: () => Date;
}

/**
 * Validate + persist a usage event. Returns 400 on malformed input so
 * a broken caller doesn't silently corrupt the billing data.
 */
export async function recordEvent(
  raw: Partial<UsageEvent>,
  deps: RecordEventDeps,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const now = deps.now ? deps.now() : new Date();

  if (!raw.siteId || typeof raw.siteId !== 'string') {
    return { ok: false, reason: 'siteId_required' };
  }
  if (!isUsageEventKind(raw.kind)) {
    return { ok: false, reason: 'invalid_kind' };
  }

  const count =
    raw.kind === 'class_a_op' || raw.kind === 'class_b_op'
      ? Math.max(0, Math.floor(raw.count ?? 1))
      : undefined;

  const bytes =
    raw.kind === 'egress' || raw.kind === 'storage_snapshot'
      ? Math.max(0, Math.floor(raw.bytes ?? 0))
      : undefined;

  const event: UsageEvent = {
    siteId: raw.siteId,
    kind: raw.kind,
    count,
    bytes,
    timestamp:
      typeof raw.timestamp === 'number' && isFinite(raw.timestamp)
        ? raw.timestamp
        : now.getTime(),
  };

  await deps.store.append(event);
  return { ok: true };
}

function isUsageEventKind(x: unknown): x is UsageEventKind {
  return (
    x === 'class_a_op' ||
    x === 'class_b_op' ||
    x === 'egress' ||
    x === 'storage_snapshot'
  );
}

/* --------------------------------------------------------------------- */
/*  Pure orchestrator — daily aggregation                                */
/* --------------------------------------------------------------------- */

export interface AggregateDeps {
  directory: SiteDirectory;
  events: EventStore;
  summaries: SummaryStore;
  exporter: OtlpExporter;
  now?: () => Date;
  /** How many days of events to retain after aggregation. */
  retentionDays?: number;
}

export interface AggregateResult {
  siteId: string;
  dayIso: string;
  counters: UsageCounters;
  cost: CostBreakdown;
  eventsAggregated: number;
  eventsTrimmed: number;
}

/** Aggregate yesterday's events into a rollup doc + OTLP record. */
export async function aggregateOneSite(
  siteId: string,
  deps: AggregateDeps,
): Promise<AggregateResult> {
  const now = deps.now ? deps.now() : new Date();
  const retentionDays = deps.retentionDays ?? 7;

  // "yesterday" in UTC — the window we're closing out on this run.
  const endOfYesterday = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const startOfYesterday = endOfYesterday - 24 * 60 * 60 * 1000;
  const dayIso = new Date(startOfYesterday).toISOString().slice(0, 10);

  const events = await deps.events.readWindow(
    siteId,
    startOfYesterday,
    endOfYesterday,
  );
  const counters = aggregateCounters(events);

  // cost.storage is pro-rated by the month fraction elapsed AT yesterday's
  // END, so the "cost of yesterday's stored bytes" is the storage fee
  // allocated to that day (1 / days-in-month).
  const storageDaysInMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const perDayFraction = 1 / storageDaysInMonth;
  const cost = computeCost({
    counters,
    monthFractionElapsed: perDayFraction,
  });

  const record = events.length === 0
    ? buildEmptyRecord(siteId, 'no_events_in_window', now)
    : buildUsageRecord(siteId, counters, cost, now);
  deps.exporter(record);

  if (events.length > 0) {
    await deps.summaries.writeDailyRollup(siteId, dayIso, counters, cost);
  }

  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const eventsTrimmed = await deps.events.trimOlderThan(siteId, cutoff);

  return {
    siteId,
    dayIso,
    counters,
    cost,
    eventsAggregated: events.length,
    eventsTrimmed,
  };
}

export async function aggregateAllSites(
  deps: AggregateDeps,
): Promise<AggregateResult[]> {
  const siteIds = await deps.directory.listSiteIds();
  const results: AggregateResult[] = [];
  for (const siteId of siteIds) {
    try {
      results.push(await aggregateOneSite(siteId, deps));
    } catch (err) {
      console.error(
        `[telemetry] aggregate failed for ${siteId}: ${
          (err as Error).message
        }`,
      );
    }
  }
  return results;
}

/* --------------------------------------------------------------------- */
/*  Pure orchestrator — dashboard fetch                                  */
/* --------------------------------------------------------------------- */

export interface GetSummaryDeps {
  summaries: SummaryStore;
  now?: () => Date;
}

export interface UsageSummaryResponse {
  siteId: string;
  yyyyMm: string;
  counters: UsageCounters;
  cost: CostBreakdown;
  /** Projected full-month total if current run-rate continues. */
  projectedMonthCost: CostBreakdown;
}

/**
 * Fetch month-to-date usage + costs and a naive linear projection for
 * the full month. Dashboard uses this to show "you're on track to
 * spend $X this month".
 */
export async function getUsageSummary(
  siteId: string,
  deps: GetSummaryDeps,
): Promise<UsageSummaryResponse | null> {
  const now = deps.now ? deps.now() : new Date();
  const yyyyMm = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}`;
  const mtd = await deps.summaries.readMonthToDate(siteId, yyyyMm);
  if (!mtd) return null;

  const f = monthFractionElapsed(now);
  // project: MTD / elapsed-fraction, with a floor of MTD itself so a
  // start-of-month fetch doesn't report an absurd projection.
  const projectedMonthCost: CostBreakdown =
    f <= 0
      ? mtd.cost
      : {
          storageUsd: Math.max(mtd.cost.storageUsd, mtd.cost.storageUsd / f),
          classAUsd: Math.max(mtd.cost.classAUsd, mtd.cost.classAUsd / f),
          classBUsd: Math.max(mtd.cost.classBUsd, mtd.cost.classBUsd / f),
          egressUsd: Math.max(mtd.cost.egressUsd, mtd.cost.egressUsd / f),
          totalUsd: Math.max(mtd.cost.totalUsd, mtd.cost.totalUsd / f),
        };

  return {
    siteId,
    yyyyMm,
    counters: mtd.counters,
    cost: mtd.cost,
    projectedMonthCost,
  };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/* --------------------------------------------------------------------- */
/*  Scheduled + HTTPS entrypoints                                        */
/* --------------------------------------------------------------------- */

export const aggregateTelemetry = onSchedule(
  { schedule: '30 4 * * *', timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    const results = await aggregateAllSites({
      directory: getDefaultDirectory(),
      events: getDefaultEventStore(),
      summaries: getDefaultSummaryStore(),
      exporter: otlpExporterToStderr,
    });
    const totalCost = results.reduce((s, r) => s + r.cost.totalUsd, 0);
    console.log(
      `[telemetry] aggregate complete: sites=${results.length} total_cost_usd=${totalCost.toFixed(4)}`,
    );
  },
);

export const recordUsageEvent = onRequest(
  { timeoutSeconds: 10, memory: '256MiB' },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }
    const result = await recordEvent(
      (req.body ?? {}) as Partial<UsageEvent>,
      { store: getDefaultEventStore() },
    );
    if (!result.ok) {
      res.status(400).json({ error: result.reason });
      return;
    }
    res.status(204).send();
  },
);

export const getUsageSummaryHttp = onRequest(
  { timeoutSeconds: 15, memory: '256MiB' },
  async (req, res) => {
    const siteId = String(req.query.siteId ?? '');
    if (!siteId) {
      res.status(400).json({ error: 'siteId_required' });
      return;
    }
    const summary = await getUsageSummary(siteId, {
      summaries: getDefaultSummaryStore(),
    });
    if (!summary) {
      res.status(404).json({ error: 'no_data_yet' });
      return;
    }
    res.status(200).json(summary);
  },
);

/* --------------------------------------------------------------------- */
/*  Production wiring                                                    */
/* --------------------------------------------------------------------- */

function getDefaultDirectory(): SiteDirectory {
  const db = admin.firestore();
  return {
    async listSiteIds() {
      const snap = await db.collection('sites').listDocuments();
      return snap.map((d) => d.id);
    },
  };
}

function getDefaultEventStore(): EventStore {
  const db = admin.firestore();
  const col = (siteId: string) =>
    db.collection('sites').doc(siteId).collection('usage_events');

  return {
    async append(event: UsageEvent) {
      await col(event.siteId).add({
        ...event,
        timestamp: Timestamp.fromMillis(event.timestamp),
      });
    },
    async readWindow(siteId, startMs, endMs) {
      const snap = await col(siteId)
        .where('timestamp', '>=', Timestamp.fromMillis(startMs))
        .where('timestamp', '<', Timestamp.fromMillis(endMs))
        .get();
      return snap.docs.map((d) => {
        const data = d.data() as UsageEvent;
        // firestore returns a Timestamp in practice; events we persist via
        // `append()` always pass through Timestamp.fromMillis. If a legacy
        // number slipped in, fall back to Number().
        const raw: unknown = (data as unknown as Record<string, unknown>).timestamp;
        const ts =
          raw && typeof (raw as { toMillis?: unknown }).toMillis === 'function'
            ? (raw as Timestamp).toMillis()
            : Number(raw);
        return { ...data, timestamp: ts };
      });
    },
    async trimOlderThan(siteId, cutoffMs) {
      const snap = await col(siteId)
        .where('timestamp', '<', Timestamp.fromMillis(cutoffMs))
        .get();
      if (snap.empty) return 0;
      const batch = db.batch();
      for (const d of snap.docs) batch.delete(d.ref);
      await batch.commit();
      return snap.size;
    },
  };
}

function getDefaultSummaryStore(): SummaryStore {
  const db = admin.firestore();
  const monthDoc = (siteId: string, yyyyMm: string) =>
    db
      .collection('sites')
      .doc(siteId)
      .collection('usage_summaries')
      .doc(yyyyMm);

  return {
    async writeDailyRollup(siteId, dayIso, counters, cost) {
      const yyyyMm = dayIso.slice(0, 7);
      const ref = monthDoc(siteId, yyyyMm);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const prior = snap.exists
          ? (snap.data() as { counters: UsageCounters; cost: CostBreakdown })
          : null;
        const nextCounters: UsageCounters = {
          storageBytes: counters.storageBytes, // latest day's avg — dashboard shows "current"
          classAOps: (prior?.counters.classAOps ?? 0) + counters.classAOps,
          classBOps: (prior?.counters.classBOps ?? 0) + counters.classBOps,
          egressBytes: (prior?.counters.egressBytes ?? 0) + counters.egressBytes,
        };
        const nextCost: CostBreakdown = {
          storageUsd: (prior?.cost.storageUsd ?? 0) + cost.storageUsd,
          classAUsd: (prior?.cost.classAUsd ?? 0) + cost.classAUsd,
          classBUsd: (prior?.cost.classBUsd ?? 0) + cost.classBUsd,
          egressUsd: (prior?.cost.egressUsd ?? 0) + cost.egressUsd,
          totalUsd: (prior?.cost.totalUsd ?? 0) + cost.totalUsd,
        };
        tx.set(
          ref,
          {
            counters: nextCounters,
            cost: nextCost,
            lastDayRolledUp: dayIso,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      });
    },
    async readMonthToDate(siteId, yyyyMm) {
      const snap = await monthDoc(siteId, yyyyMm).get();
      if (!snap.exists) return null;
      const data = snap.data() as {
        counters: UsageCounters;
        cost: CostBreakdown;
      };
      return { counters: data.counters, cost: data.cost };
    },
  };
}

/**
 * OTLP exporter: emit a JSON-line record on stderr. Cloud Logging
 * ingests this with full severity + jsonPayload. An OTEL collector
 * sidecar (deployed in wave 0.6) subscribes to the log sink and
 * forwards OTLP-native to the eventual backend (grafana-tempo,
 * honeycomb, etc. — product choice TBD).
 */
export function otlpExporterToStderr(record: OtlpTelemetryRecord): void {
  // severity-appropriate stream + a single-line JSON payload. Cloud
  // Logging parses the JSON automatically when it's the whole line.
  const line = JSON.stringify(record);
  if (record.severity === 'ERROR') console.error(line);
  else if (record.severity === 'WARN') console.warn(line);
  else console.log(line);
}
