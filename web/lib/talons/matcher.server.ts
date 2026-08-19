/**
 * Talon trigger matcher — the fan-in from live fleet signals to talon runs
 * (talons wave 2, task 2.3).
 *
 * The schedule sweep asks "which talons are due?" and answers it with a query.
 * Threshold and event triggers cannot work that way: the breach or the event
 * arrives first, at whichever dispatcher owns it, and the talons that care have
 * to be found afterwards. This module is that lookup, and the ONLY one — the
 * dispatch sites call {@link tapTalonMatcher} and know nothing about talons
 * beyond the shape of the signal they hand over.
 *
 * ## Where the signals come from (verified 2026-08-14)
 *
 * Three dispatchers, because there is no single chokepoint every fleet event
 * passes through:
 *
 *   1. `/api/alerts/trigger` — threshold breaches, posted by the metrics
 *      cloud function once an alert rule has fired and cleared its cooldown.
 *   2. `/api/agent/alert` — `process_crash`, `process_start_failed`, and
 *      `exe_missing`, posted by the agent under its own bearer token.
 *   3. `/api/cron/health-check` — `machine_offline`, which exists nowhere else:
 *      a machine that has gone offline cannot report that it has.
 *
 * A fourth path is not http at all. `process_restarted` and the `display_*`
 * events are written by the agent DIRECTLY into `sites/{siteId}/logs` and never
 * touch a web route, so they reach this module through the
 * `onTalonLogEventCreated` firestore trigger (`functions/src/talonLogEvents.ts`)
 * calling `POST /api/talons/internal/match`.
 *
 * ## Taps never block and never throw
 *
 * Every one of those dispatchers has a job of its own — deliver an email, fire
 * a webhook, answer an agent. A talon run is a slow side quest (it can capture
 * a screenshot and call a vision model), and a talon that is misconfigured must
 * not turn its host route into a 500. {@link tapTalonMatcher} is therefore
 * fire-and-forget with a terminal catch, and the per-talon loop inside
 * {@link matchAndRunTalons} isolates each talon from its siblings.
 *
 * ## Delayed event triggers
 *
 * An event trigger may carry a `delayMinutes` — "a process came back up, wait
 * three minutes for it to finish booting, THEN look at the screen". Those
 * talons are NOT run here. This module writes a `pending` deferral into
 * `talon_runs` and returns; `/api/cron/talons` claims it once `runAfterAt`
 * passes and runs the talon then. The delay is therefore honoured across a
 * deploy or a process restart, which an in-memory timer would not survive.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { generateCorrelationId } from '@/lib/auditLog.server';
import logger from '@/lib/logger';
import { runTalon, type TalonRunSummary } from './engine.server';
import type { StoredTalon } from './store.server';
import { TALON_EVENT_TYPES, type TalonDoc, type TalonOperator, type TalonRunDoc } from './types';
import { MAX_TALONS_PER_SITE } from './validation';

/** A metric threshold was crossed on one machine. */
export interface TalonThresholdMatchEvent {
  kind: 'threshold';
  /** Raw dispatcher value — compared against `TALON_METRICS` members by equality. */
  metric: string;
  /** Raw dispatcher value — compared against `TALON_OPERATORS` members by equality. */
  operator: string;
  /** The observed metric value that breached, NOT the rule's bound. */
  value: number;
  machineId: string;
}

/**
 * A catalog event landed. `machineId` is absent only for a site-level event —
 * see the scope rule in {@link matchesScope}.
 */
export interface TalonEventMatchEvent {
  kind: 'event';
  /** Raw dispatcher value — compared against `TALON_EVENT_TYPES` members by equality. */
  eventType: string;
  machineId?: string;
}

export type TalonMatchEvent = TalonThresholdMatchEvent | TalonEventMatchEvent;

/** What one dispatch did. `matched` counts TALONS; `runs` counts EXECUTIONS. */
export interface TalonMatchResult {
  /** Talons whose trigger and scope both matched the signal. */
  matched: number;
  /** Every run recorded, across all matched talons — a visual-check talon contributes one per machine. */
  runs: TalonRunSummary[];
}

/* -------------------------------------------------------------------------- */
/*  matching                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Does the breach value satisfy the talon's own predicate?
 *
 * A breach payload arriving means an ALERT RULE fired; it says nothing about
 * whether this talon's bound was crossed. A rule at `cpu_percent > 80` and a
 * talon at `cpu_percent > 95` are different questions, and 84% is only an
 * answer to the first.
 *
 * The `default` is not dead code: `operator` is typed off a Firestore document,
 * so a hand-edited or future-schema value can reach here at runtime.
 */
function satisfiesThreshold(value: number, operator: TalonOperator, bound: number): boolean {
  switch (operator) {
    case '>':
      return value > bound;
    case '<':
      return value < bound;
    case '>=':
      return value >= bound;
    case '<=':
      return value <= bound;
    default:
      return false;
  }
}

/**
 * `machineIds === null` means "every machine in the site" and matches anything,
 * including a signal that names no machine.
 *
 * A machine-scoped talon needs the signal to name one of its machines, so a
 * site-level signal (no `machineId`) matches only the all-machines talons —
 * "restart TouchDesigner on LOBBY-01" cannot be a sensible response to an event
 * that never said which machine it happened on.
 *
 * A non-array value is read as `null`: an unscoped talon is the safe default and
 * matches what `validateTalonInput` normalizes a missing scope to.
 */
function matchesScope(machineIds: unknown, eventMachineId: string | undefined): boolean {
  if (!Array.isArray(machineIds)) return true;
  if (typeof eventMachineId !== 'string' || eventMachineId.length === 0) return false;
  return machineIds.includes(eventMachineId);
}

/** Does this talon subscribe to the signal, on a machine it is scoped to? */
function matchesEvent(talon: StoredTalon, event: TalonMatchEvent): boolean {
  const trigger = talon.trigger;
  if (!trigger) return false;
  if (!matchesScope(talon.scope?.machineIds, event.machineId)) return false;

  if (event.kind === 'threshold') {
    return (
      trigger.type === 'threshold' &&
      trigger.metric === event.metric &&
      trigger.operator === event.operator &&
      satisfiesThreshold(event.value, trigger.operator, trigger.value)
    );
  }

  return (
    trigger.type === 'event' &&
    Array.isArray(trigger.eventTypes) &&
    trigger.eventTypes.some((eventType) => eventType === event.eventType)
  );
}

/**
 * Lowercase one-liner recorded on the run, describing what actually happened
 * rather than what the talon subscribes to (which `describeTrigger` already
 * covers). For a breach that distinction matters: the observed value is the
 * operational fact, the bound is only context.
 */
function describeMatch(talon: StoredTalon, event: TalonMatchEvent): string {
  if (event.kind === 'event') return `on ${event.eventType}`;
  // A matched threshold event always carries a threshold trigger; the guard
  // narrows the union for the compiler, it does not describe a reachable state.
  const bound = talon.trigger.type === 'threshold' ? ` ${talon.trigger.value}` : '';
  return `${event.metric} ${event.value} crossed ${event.operator}${bound}`;
}

/* -------------------------------------------------------------------------- */
/*  deferral                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The talon's configured wait, in whole minutes, or 0 for "run now".
 *
 * Only an event trigger can carry one — `validateTalonInput` rejects
 * `delayMinutes` on the other two forms — so a threshold breach never defers.
 * Read defensively because `trigger` is typed off a Firestore document.
 */
function eventDelayMinutes(talon: StoredTalon): number {
  const trigger = talon.trigger;
  if (!trigger || trigger.type !== 'event') return 0;
  const delay = trigger.delayMinutes;
  if (typeof delay !== 'number' || !Number.isFinite(delay) || delay <= 0) return 0;
  return Math.floor(delay);
}

/**
 * Record the intent to run this talon `delayMinutes` from now, and let the
 * sweep do it.
 *
 * ## Coalescing
 *
 * A burst of identical events during the wait — a process that crash-loops
 * eight times while the talon is holding for three minutes — must produce ONE
 * run, not eight. Before writing, this looks for a `pending` deferral for the
 * same talon on the same machine and skips if it finds one. The lookup is two
 * equality filters (`talonId`, `status`), which Firestore serves off its
 * automatic single-field indexes, with the machine compared in memory: a
 * site-level deferral has NO `machineId` field, and `where('machineId','==',
 * null)` does not match a missing field.
 *
 * The check is deliberately not transactional. Two events landing in the same
 * instant can both find nothing and both write, and that is a benign duplicate:
 * each deferral is claimed exactly once at fire time, and the second fire hits
 * the talon's cooldown. Serializing every event through a transaction to avoid
 * a rare extra crumb would be a worse trade on the hot path.
 *
 * A coalesced event is silent by design — a crash loop is exactly the case that
 * produces them, and one log line per crash is the noise the coalescing exists
 * to prevent.
 */
async function deferTalonRun(
  db: Firestore,
  siteId: string,
  talon: StoredTalon,
  event: TalonEventMatchEvent,
  delayMinutes: number,
  now: Date,
): Promise<void> {
  const runs = db.collection('sites').doc(siteId).collection('talon_runs');

  const pending = await runs
    .where('talonId', '==', talon.id)
    .where('status', '==', 'pending')
    .get();

  const machineId = event.machineId ?? null;
  const alreadyPending = pending.docs.some(
    (doc) => ((doc.data() as TalonRunDoc).machineId ?? null) === machineId,
  );
  if (alreadyPending) return;

  // `machineName` is left off on purpose: resolving it costs a machine read on
  // a path that runs per event, and the run the deferral fires resolves it
  // properly. The run list falls back to the id.
  const deferral: TalonRunDoc = {
    talonId: talon.id,
    talonName: talon.name,
    triggerType: 'event',
    triggerSummary: `${describeMatch(talon, event)} · after ${delayMinutes} min`,
    ...(event.machineId ? { machineId: event.machineId } : {}),
    status: 'pending',
    // Equal by construction: `createdAt` is the field the deferral lifecycle
    // reads, `startedAt` is what the run history orders by (see TalonRunDoc).
    createdAt: now,
    startedAt: now,
    runAfterAt: new Date(now.getTime() + delayMinutes * 60_000),
    outputs: [],
    correlationId: generateCorrelationId(),
    ...(talon.chatId ? { chatId: talon.chatId } : {}),
  };

  await runs.add(deferral);
}

/* -------------------------------------------------------------------------- */
/*  dispatch                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The site's enabled talons.
 *
 * Filtered on `enabled` server-side (a single-field index Firestore maintains
 * automatically) and capped at {@link MAX_TALONS_PER_SITE}, the same ceiling
 * `createTalon` enforces. The cap is belt-and-braces: the create path counts
 * before writing rather than transacting, so a race can leave a site marginally
 * over, and a signal that fans out unbounded runs is not the place to discover
 * that. Trigger type and scope are matched in memory — at N ≤ 20 a second query
 * per signal buys nothing.
 */
async function readEnabledTalons(db: Firestore, siteId: string): Promise<StoredTalon[]> {
  const snapshot = await db
    .collection('sites')
    .doc(siteId)
    .collection('talons')
    .where('enabled', '==', true)
    .limit(MAX_TALONS_PER_SITE)
    .get();

  return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as TalonDoc) }));
}

/**
 * Find every talon subscribed to `event` and run it.
 *
 * Talons run sequentially and are individually isolated: one talon throwing
 * (a dead webhook host, a Firestore write that lost a race) must not stop the
 * others, exactly as one failed output does not stop a run's remaining outputs.
 * Cooldown, the in-flight guard, and the auto-disable backoff all belong to the
 * engine and are not re-implemented here.
 *
 * A talon carrying a delay is DEFERRED instead of run — it still counts as
 * matched, and contributes no run to the result until the sweep fires it.
 */
export async function matchAndRunTalons(
  db: Firestore,
  siteId: string,
  event: TalonMatchEvent,
): Promise<TalonMatchResult> {
  // A breach with a non-numeric value is not a breach anybody can compare
  // against a bound. Dropped here rather than in each dispatcher, so the
  // dispatchers stay free to forward what they were handed.
  if (event.kind === 'threshold' && !Number.isFinite(event.value)) {
    logger.warn(`Talon matcher dropped a non-numeric ${event.metric} breach`, {
      context: 'talons/matcher',
      data: { siteId, machineId: event.machineId },
    });
    return { matched: 0, runs: [] };
  }

  // Catalog check BEFORE the read, so a tap on a busy dispatcher costs nothing
  // for the events no talon can subscribe to — `/api/agent/alert` fires this
  // tap for `connection_failure` on every agent alert, and that must not become
  // a Firestore query per alert.
  if (event.kind === 'event' && !TALON_EVENT_TYPES.some((type) => type === event.eventType)) {
    return { matched: 0, runs: [] };
  }

  const matches = (await readEnabledTalons(db, siteId)).filter((talon) =>
    matchesEvent(talon, event),
  );
  if (matches.length === 0) return { matched: 0, runs: [] };

  const now = new Date();
  const runs: TalonRunSummary[] = [];
  for (const talon of matches) {
    try {
      if (event.kind === 'event') {
        const delayMinutes = eventDelayMinutes(talon);
        if (delayMinutes > 0) {
          await deferTalonRun(db, siteId, talon, event, delayMinutes, now);
          continue;
        }
      }

      runs.push(
        ...(await runTalon(db, talon, {
          siteId,
          ...(event.machineId ? { machineId: event.machineId } : {}),
          triggerSummary: describeMatch(talon, event),
        })),
      );
    } catch (error) {
      logger.error(`Talon ${talon.id} threw while running from a ${event.kind} signal`, {
        context: 'talons/matcher',
        data: { siteId, error: String(error) },
      });
    }
  }

  return { matched: matches.length, runs };
}

/**
 * Fire-and-forget {@link matchAndRunTalons} from a dispatch site.
 *
 * Returns immediately: the caller's response must not wait on a talon run, and
 * must not fail because one did. Every rejection — including a Firestore read
 * that never reached the per-talon loop — terminates here.
 */
export function tapTalonMatcher(
  db: Firestore,
  siteId: string,
  event: TalonMatchEvent,
): void {
  void matchAndRunTalons(db, siteId, event).catch((error) => {
    logger.error('Talon matcher tap failed', {
      context: 'talons/matcher',
      data: { siteId, kind: event.kind, error: String(error) },
    });
  });
}
