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

/** Hand a directive to hoot to act on. */
export interface TalonHootOutput {
  type: 'cortex';
  directive: string;
  /**
   * Let the unattended turn reach tier-2 tools (process control, screenshots,
   * service management) instead of the read-only tier-1 set. Absent — the
   * default — keeps the turn read-only, and the validator normalizes an
   * explicit `false` away so an opted-out talon has ONE representation on the
   * document.
   *
   * Authoring it is a site-admin privilege, gated in `store.server.ts` next to
   * the `command` output gate: a turn that can restart a process is the same
   * power class as a talon that queues the restart itself. Tier 3 stays
   * unreachable on this path whatever the flag says — see `hootOutput.server`.
   */
  allowActions?: boolean;
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
  | TalonHootOutput
  | TalonCommandOutput;

export type TalonOutputType = TalonOutput['type'];

/** Which machines the talon applies to. `null` = every machine in the site. */
export interface TalonScope {
  machineIds: string[] | null;
}

/** How the talon was authored — the UI editor or a hoot conversation. */
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

/* -------------------------------------------------------------------------- */
/*  system-disabled reasons                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Why the SYSTEM switched a talon off. Absent on a talon an operator paused
 * themselves — the toggle clears it, because a human decision needs no stated
 * cause from us.
 *
 * The four `creator_*` reasons are UNRECOVERABLE: the talon's author can no
 * longer back the run, and no number of retries changes that, so the talon is
 * disabled the first time one is hit rather than after ten wasted firings.
 * `repeated_failures` is the opposite case — transient faults (a machine
 * offline, a rate limit, a provider 500) that only add up to a verdict after
 * `AUTO_DISABLE_AFTER_FAILURES` of them in a row.
 *
 * Stored as a stable code, never as a sentence: the copy below is rewritten
 * whenever the wording improves, and a doc written last month must pick that up
 * instead of preserving the old phrasing forever.
 */
export type TalonDisabledReason =
  | 'creator_not_a_user'
  | 'creator_deleted'
  | 'creator_access_revoked'
  | 'creator_missing_llm_key'
  | 'repeated_failures';

/**
 * The `creator_*` subset — the reasons a REASSIGNMENT resolves.
 *
 * Handing a talon to a present, keyed author falsifies every one of these, so
 * `reassignTalons` re-arms exactly these and leaves the rest alone:
 * `repeated_failures` describes the talon rather than its author, and a talon a
 * human paused carries no reason at all and must stay paused.
 *
 * Derived from the union by a total record so a new reason cannot be added
 * without deciding, at the type level, which side of that line it falls on.
 */
const CREATOR_DISABLED_REASONS: Readonly<Record<TalonDisabledReason, boolean>> = {
  creator_not_a_user: true,
  creator_deleted: true,
  creator_access_revoked: true,
  creator_missing_llm_key: true,
  repeated_failures: false,
};

/** Whether a stored reason is one a reassignment fixes. */
export function isCreatorDisabledReason(
  reason: TalonDisabledReason | undefined | null,
): boolean {
  return reason ? CREATOR_DISABLED_REASONS[reason] === true : false;
}

/**
 * The one place a disable reason becomes words. Lowercase, no jargon, and no
 * count baked into the text — `AUTO_DISABLE_AFTER_FAILURES` is free to change.
 */
export const TALON_DISABLED_REASON_COPY: Readonly<Record<TalonDisabledReason, string>> = {
  creator_not_a_user:
    'nobody owns this talon, so there is no ai key it can run with',
  creator_deleted:
    'the person who created this talon no longer has an account',
  creator_access_revoked:
    'the person who created this talon no longer has access to this site',
  creator_missing_llm_key:
    'the person who created this talon has no ai key saved in settings → hoot',
  repeated_failures: 'it failed too many times in a row',
};

/** The human sentence for a stored reason, or `null` when it is unrecognized. */
export function describeTalonDisabledReason(
  reason: string | null | undefined,
): string | null {
  if (!reason) return null;
  return TALON_DISABLED_REASON_COPY[reason as TalonDisabledReason] ?? null;
}

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
  /**
   * Set when the SYSTEM disabled this talon; cleared whenever a human toggles
   * `enabled` either way. Never present on an enabled talon.
   */
  disabledReason?: TalonDisabledReason;
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
  /**
   * Set when THIS output's failure is unrecoverable and cost the talon its
   * enabled state. A run can hold several outputs and only one of them be
   * fatal, so it is recorded here as well as on the run — this says which
   * output was the problem, the run-level field says what it cost.
   */
  disabledReason?: TalonDisabledReason;
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
  /**
   * Set when this run is the one that disabled the talon — so the run history
   * explains itself without the reader having to go and read the talon.
   */
  disabledReason?: TalonDisabledReason;
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

/* -------------------------------------------------------------------------- */
/*  talon presets — reusable templates                                        */
/* -------------------------------------------------------------------------- */

/**
 * Something a template needs before the talon it produces can be created.
 *
 * `llm_key` — a visual-check condition or a hoot output, both of which the
 * store refuses unless the talon's author has an llm key of their own.
 * `process_target` — a `command` output whose process the operator still has to
 * pick, because a process id is per-machine and never travels in a template.
 *
 * Canonical here rather than beside the built-in catalog: the editor, the hook
 * and the catalog all need it, and only the catalog can afford to import data.
 */
export type TalonPresetRequirement = 'llm_key' | 'process_target';

/**
 * The talon-shaped payload a preset carries: the caller-owned half of a talon
 * MINUS `scope` and `enabled`.
 *
 * Both omissions are deliberate. `scope.machineIds` holds machine ids that mean
 * nothing in another site — and an empty array is rejected outright — so a
 * template seeds "every machine" and the operator narrows it. `enabled` is the
 * instance's own armed/paused state; a template must not decide whether the
 * talon it produces is live.
 */
export interface TalonPresetTemplate {
  /** Default name for the talon this preset seeds — NOT the preset's own name. */
  name: string;
  description?: string;
  trigger: TalonTrigger;
  condition: TalonCondition;
  outputs: TalonOutput[];
  cooldownMinutes: number;
}

/**
 * `config/{siteId}/talon_presets/{presetId}`
 *
 * Same field vocabulary as the other `config/{siteId}/*_presets` families
 * (`isBuiltIn` / `order` / `createdBy`), so the built-in merge and the shared
 * preset routes behave identically. Doc ids are `talon-{slug}-{epochMs}`,
 * except a built-in override, which pins `builtin-{slug}`.
 *
 * The talon payload is nested under `template` rather than flattened: flat
 * fields would collide the preset's own `name`/`description` with the ones the
 * talon it creates should start from.
 */
export interface TalonPresetDoc {
  name: string;
  description?: string;
  template: TalonPresetTemplate;
  isBuiltIn: boolean;
  order: number;
  createdBy: string;
  createdAt: TalonTimestamp;
  updatedAt?: TalonTimestamp;
}
