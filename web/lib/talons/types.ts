/**
 * Talon document shapes — the automation primitive (trigger → condition →
 * outputs) stored at `sites/{siteId}/talons/{talonId}` with per-execution
 * records at `sites/{siteId}/talon_runs/{runId}`.
 *
 * Naming: the term is **talon** everywhere. Never "action" (`web/lib/actions/`
 * is an unrelated directory of server mutation cores) and never "automation".
 *
 * Dependency-free on purpose — no Firestore imports — so the client editor,
 * the server store, the scheduler, and the run recorder can all import these
 * without dragging an SDK across the boundary. Keep it that way.
 */

/**
 * Every shape a Firestore time field can arrive in: an admin- or client-SDK
 * `Timestamp` (both expose `toMillis()`), a `Date` (what we write, and what
 * tests inject), epoch milliseconds, a plain `{seconds}` / `{_seconds}` pair
 * from JSON round-tripping across an API boundary, or an ISO string.
 *
 * Mirrors `BillingTimestamp` in `@/lib/types/customer` rather than importing
 * it — that type belongs to the billing domain, and this module stays free of
 * cross-domain coupling.
 */
export type TalonTimestamp =
  | Date
  | number
  | string
  | { toMillis: () => number }
  | { seconds: number; nanoseconds?: number }
  | { _seconds: number; _nanoseconds?: number };

/**
 * Day-of-week keys. Redeclared rather than imported from
 * `@/components/DayPillSelector` (that module is `'use client'` and would drag
 * React into every server importer) — the union and the canonical week order
 * must stay identical to it and to `ScheduleEditor`'s block days.
 */
export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/** Canonical week order — normalized schedule entries are sorted by this. */
export const DAY_KEYS: readonly DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/**
 * Metrics a threshold trigger can watch.
 *
 * MUST stay in sync with `METRIC_PATHS` in `functions/src/metricsHistory.ts`
 * (~line 106). A metric listed here without a path there has no recorded
 * history, so its threshold could never evaluate; a metric added there stays
 * invisible to talons until it is added here.
 */
export const TALON_METRICS = [
  'cpu_percent',
  'memory_percent',
  'disk_percent',
  'gpu_percent',
  'cpu_temp',
  'gpu_temp',
  'network_latency',
  'network_packet_loss',
] as const;

export type TalonMetric = (typeof TALON_METRICS)[number];

/** Comparison operators available to a threshold trigger. */
export const TALON_OPERATORS = ['>', '<', '>=', '<='] as const;

export type TalonOperator = (typeof TALON_OPERATORS)[number];

/**
 * Closed catalog of events an event trigger can subscribe to.
 *
 * The first five are process/machine lifecycle events; the rest are the
 * `display_*` events registered in `@/lib/alerts/displayEventRouting`
 * (snake_case agent form — the dotted `display.*` names are the webhook wire
 * format, not subscription keys). Adding an event to that routing table means
 * adding it here too, or talons can never fire on it.
 *
 * Where each one is dispatched from (verified 2026-08-14 — see
 * `@/lib/talons/matcher.server`):
 *   - `process_crash`, `process_start_failed`, `exe_missing` — the agent posts
 *     them to `/api/agent/alert`.
 *   - `machine_offline` — synthesized by the health-check cron, never by an
 *     agent: a machine that is offline cannot report that it is.
 *   - `process_restarted` and every `display_*` event — the agent writes them
 *     straight to `sites/{siteId}/logs`, so they reach talons through the
 *     `onTalonLogEventCreated` firestore trigger rather than an http route.
 */
export const TALON_EVENT_TYPES = [
  'process_crash',
  'process_start_failed',
  'process_restarted',
  'exe_missing',
  'machine_offline',
  'display_monitor_removed',
  'display_apply_failed',
  'display_auto_revert_fired',
  'display_sync_lost',
  'display_drift',
  'display_monitor_swapped',
  'display_mosaic_disabled',
  'display_apply_refused_mosaic',
  'display_monitor_added',
  'display_apply_succeeded',
] as const;

export type TalonEventType = (typeof TALON_EVENT_TYPES)[number];

/** Command types a `command` output may queue — a strict subset of `ALLOWED_COMMAND_TYPES`. */
export const TALON_COMMAND_TYPES = ['restart_process', 'start_process', 'stop_process'] as const;

export type TalonCommandType = (typeof TALON_COMMAND_TYPES)[number];

/** One fixed clock time on a set of weekdays, e.g. every mon/wed at 09:30. */
export interface TalonScheduleEntry {
  /** Stable client-generated id so editor rows keep identity across edits. */
  id: string;
  days: DayKey[];
  /** 24-hour `HH:MM`, matching the format `ScheduleEditor` writes. */
  time: string;
}

/** Fixed clock times. Mutually exclusive with the interval form. */
export interface TalonScheduleEntriesTrigger {
  type: 'schedule';
  entries: TalonScheduleEntry[];
  intervalMinutes?: never;
}

/** Fire every N minutes. Mutually exclusive with the entries form. */
export interface TalonIntervalTrigger {
  type: 'schedule';
  intervalMinutes: number;
  entries?: never;
}

/** Fire when a machine metric crosses a bound. */
export interface TalonThresholdTrigger {
  type: 'threshold';
  metric: TalonMetric;
  operator: TalonOperator;
  value: number;
}

/** Fire when one of the subscribed events lands. */
export interface TalonEventTrigger {
  type: 'event';
  eventTypes: TalonEventType[];
  /**
   * Minutes to wait between the event landing and the talon running, 1–1440.
   *
   * Absent means "run the moment the event arrives" — the validator normalizes
   * an explicit 0 away, so no-delay talons all persist identically. Meaningful
   * on event triggers ONLY: a schedule already carries its own timing, and a
   * threshold breach is a level, not an edge, so waiting on one would just
   * re-ask a question the next breach answers.
   *
   * A delayed match is not executed inline. The matcher writes a `pending`
   * deferral into `talon_runs` and `/api/cron/talons` fires it once
   * `runAfterAt` passes — see {@link TalonRunDoc}.
   */
  delayMinutes?: number;
}

export type TalonTrigger =
  | TalonScheduleEntriesTrigger
  | TalonIntervalTrigger
  | TalonThresholdTrigger
  | TalonEventTrigger;

export type TalonTriggerType = TalonTrigger['type'];

/** No gate — the outputs run whenever the trigger fires. */
export interface TalonNoCondition {
  type: 'none';
}

/** Gate the outputs on a vision check of a fresh screenshot. */
export interface TalonVisualCheckCondition {
  type: 'visual_check';
  /** Natural-language statement the screenshot must satisfy. */
  expectation: string;
  /**
   * Monitor index, matching the `capture_screenshot` command convention:
   * 0 (default) = all monitors combined, 1 = primary, 2 = second, and so on.
   */
  monitor?: number;
}

export type TalonCondition = TalonNoCondition | TalonVisualCheckCondition;

export type TalonConditionType = TalonCondition['type'];

/** Notify the site's configured alert recipients. */
export interface TalonEmailOutput {
  type: 'email';
}

/**
 * POST the run payload to an external endpoint. The signing secret lives in
 * `talon_secrets`, never on the talon doc.
 */
export interface TalonWebhookOutput {
  type: 'webhook';
  url: string;
}

/** Hand a directive to cortex to act on. */
export interface TalonCortexOutput {
  type: 'cortex';
  directive: string;
}

/** Queue a process-control command against the machines in scope. */
export interface TalonCommandOutput {
  type: 'command';
  commandType: TalonCommandType;
  processId?: string;
  processName?: string;
}

export type TalonOutput =
  | TalonEmailOutput
  | TalonWebhookOutput
  | TalonCortexOutput
  | TalonCommandOutput;

export type TalonOutputType = TalonOutput['type'];

/** Which machines the talon applies to. `null` = every machine in the site. */
export interface TalonScope {
  machineIds: string[] | null;
}

/** How the talon was authored — the UI editor or a cortex conversation. */
export type TalonCreatedVia = 'ui' | 'cortex';

/**
 * `running` → `succeeded` / `failed` / `skipped` is the lifecycle of an
 * EXECUTION. `pending` → `fired` / `missed` / `skipped` is the lifecycle of a
 * DEFERRAL — the crumb a delayed event trigger writes while it waits out
 * `delayMinutes`. Both live in `talon_runs`, and `missed` means the same thing
 * on either: the window closed before anything ran.
 */
export type TalonRunStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'missed'
  | 'pending'
  | 'fired';

export type TalonOutputStatus = 'sent' | 'failed' | 'skipped';

/** `sites/{siteId}/talons/{talonId}` */
export interface TalonDoc {
  schemaVersion: 1;
  name: string;
  description?: string;
  enabled: boolean;
  trigger: TalonTrigger;
  condition: TalonCondition;
  outputs: TalonOutput[];
  scope: TalonScope;
  /** Minimum gap between runs. */
  cooldownMinutes: number;
  /** uid of the authoring user. */
  createdBy: string;
  createdVia: TalonCreatedVia;
  /** Set when `createdVia === 'cortex'` — the chat the talon came from. */
  chatId?: string;
  createdAt: TalonTimestamp;
  updatedAt: TalonTimestamp;
  /** Schedule triggers only — when the scheduler should next evaluate. */
  nextRunAt?: TalonTimestamp;
  lastRunAt?: TalonTimestamp;
  lastRunStatus?: TalonRunStatus;
  lastRunId?: string;
  /** Reset to 0 on any successful run; drives auto-disable backoff. */
  consecutiveFailures: number;
}

/** Outcome of the condition gate, recorded on the run. */
export interface TalonRunCondition {
  type: TalonConditionType;
  verdict: 'pass' | 'fail';
  /** Vision-model confidence, 0–1, when the condition produced one. */
  confidence?: number;
  reason?: string;
  /** Storage path of the evaluated screenshot. */
  screenshotPath?: string;
  /** Signed read URL for `screenshotPath`, when one was minted. */
  screenshotUrl?: string;
}

/** Per-output delivery result, recorded on the run. */
export interface TalonRunOutput {
  type: TalonOutputType;
  status: TalonOutputStatus;
  detail?: string;
  /** Webhook outputs only. */
  httpStatus?: number;
  error?: string;
}

/**
 * `sites/{siteId}/talon_runs/{runId}`
 *
 * Two kinds of document share this collection and this shape:
 *
 *   - an EXECUTION, written `running` by the engine and finalized in place;
 *   - a DEFERRAL, written `pending` by the matcher when an event trigger
 *     carries a `delayMinutes`, and resolved by the sweep once `runAfterAt`
 *     passes. The four `runAfterAt` / `createdAt` / `firedAt` / `firedRunIds`
 *     fields below belong to that second kind and are absent on every
 *     execution.
 *
 * A deferral still stamps `startedAt` (equal to `createdAt`): the run history —
 * `useTalonRuns` and the runs api alike — orders by `startedAt`, and Firestore
 * excludes documents missing an ordered field, so a crumb without it would be
 * invisible on the surface it exists to explain.
 */
export interface TalonRunDoc {
  talonId: string;
  /** Denormalized so the run list renders without a talon lookup. */
  talonName: string;
  triggerType: TalonTriggerType;
  /** Human-readable trigger summary, e.g. `cpu_percent > 90`. */
  triggerSummary: string;
  machineId?: string;
  machineName?: string;
  status: TalonRunStatus;
  startedAt: TalonTimestamp;
  completedAt?: TalonTimestamp;
  durationMs?: number;
  condition?: TalonRunCondition;
  outputs: TalonRunOutput[];
  /** Ties the run to its audit-log entries and downstream commands. */
  correlationId: string;
  chatId?: string;
  error?: string;
  /** True when an operator ran the talon on demand rather than the trigger firing. */
  manual?: boolean;
  /** Deferral only — the instant the delay expires and the sweep may fire it. */
  runAfterAt?: TalonTimestamp;
  /** Deferral only — when the event landed and the deferral was written. */
  createdAt?: TalonTimestamp;
  /** Deferral only — when the sweep claimed it out of `pending`. */
  firedAt?: TalonTimestamp;
  /** Deferral only — ids of the runs the fire produced, empty when none were. */
  firedRunIds?: string[];
}
