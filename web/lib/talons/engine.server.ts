/**
 * Talon run engine — trigger → condition → outputs (talons wave 2, task 2.1).
 *
 * The one place a talon is actually executed. The scheduler sweep, the event
 * router, and the dashboard's "run now" button all land here, so cooldown, the
 * in-flight guard, run recording, condition evaluation, output ordering, and
 * the auto-disable backoff can't be reimplemented three slightly different ways.
 *
 * ## What a run is
 *
 * One `sites/{siteId}/talon_runs/{runId}` document per execution, written
 * `running` up front and finalized in place. A `visual_check` condition is
 * inherently per-machine — a screenshot of "the site" is not a thing — so those
 * talons produce one run PER TARGET MACHINE. Everything else produces a single
 * site-level run, which may still name the machine its trigger fired for.
 *
 * ## Skips are recorded, not swallowed
 *
 * `TalonRunDoc` has one free-text field (`error`), so a skipped run carries its
 * reason there: `already_running`, `machine_offline`, `no_interactive_session`.
 * That is deliberate — "this talon did nothing because the machine has no
 * logged-in user" is an operational fact somebody needs to be able to read off
 * the run list, and it is not the same fact as "this talon failed".
 *
 * Two skips are silent by design and write no run at all: a disabled talon and
 * a talon still inside its cooldown. A hot threshold would otherwise bury the
 * real runs under hundreds of cooldown records.
 *
 * ## Failure accounting
 *
 * `consecutiveFailures` counts failed *executions*, not failed outputs, and
 * resets on any success. At {@link AUTO_DISABLE_AFTER_FAILURES} the talon is
 * disabled and the disable is audited — a talon pointed at a decommissioned
 * machine stops paging people rather than failing forever.
 */
import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import { emitMutation } from '@/lib/auditLogClient';
import { generateCorrelationId } from '@/lib/auditLog.server';
import type { Actor } from '@/lib/capabilities';
import { timestampToMs } from '@/lib/firestoreTime.server';
import logger from '@/lib/logger';
import {
  createWebhookBillingCache,
  type WebhookBillingCache,
} from '@/lib/billing/webhookDelivery.server';
import {
  executeTalonOutput,
  resolveBaseUrl,
  type TalonOutputContext,
} from './outputs.server';
import { getTalon, TalonStoreError, type StoredTalon } from './store.server';
import type {
  TalonRunCondition,
  TalonRunDoc,
  TalonRunOutput,
  TalonRunStatus,
  TalonTrigger,
} from './types';
import { evaluateVisualCheck, TalonVisualCheckError } from './visualCheck.server';

/** Consecutive failed runs before the talon disables itself. */
export const AUTO_DISABLE_AFTER_FAILURES = 10;

/**
 * How long a `running` run may sit before the next execution takes it over.
 * Longer than any single run can legitimately take (a visual check is a 45s
 * capture plus a model call), short enough that a process killed mid-run
 * doesn't wedge the talon until someone notices.
 */
export const STALE_RUN_MS = 10 * 60_000;

/** Sentinel `machineId` on the companion log entry for a site-level run. */
const SITE_LOG_SENTINEL = 'site';

/** What fired the talon, and how the run should be recorded. */
export interface TalonRunContext {
  siteId: string;
  /** Human-readable, lowercase. Derived from the trigger when omitted. */
  triggerSummary?: string;
  /** The machine the trigger fired for — a threshold breach or a machine event. */
  machineId?: string;
  /** Operator-initiated: bypasses the cooldown and stamps `manual` on the run. */
  manual?: boolean;
  /** Injectable clock for tests; production omits it. */
  now?: Date;
}

/** What one execution did, returned in the order the runs were recorded. */
export interface TalonRunSummary {
  runId: string;
  status: TalonRunStatus;
  machineId?: string;
  outputs: TalonRunOutput[];
  condition?: TalonRunCondition;
  /** Skip reason or failure detail, mirroring the run document's `error`. */
  error?: string;
}

interface TargetMachine {
  id: string;
  name: string;
  online: boolean;
}

/**
 * The minimum needed to WRITE a run and its companion log. Split out from
 * {@link RunEnvironment} so the in-flight guard can record its skip without
 * first paying for the site read and scope resolution a real run needs.
 */
interface RunRecordEnv {
  db: Firestore;
  siteId: string;
  triggerSummary: string;
  manual: boolean;
  now: Date;
}

/** Everything the per-run executor needs that is constant across a talon's runs. */
interface RunEnvironment extends RunRecordEnv {
  siteName: string;
  siteLabel: string;
  baseUrl: string;
  billingCache: WebhookBillingCache;
  /** Machines a `command` output acts on. */
  targetMachineIds: string[];
}

/* -------------------------------------------------------------------------- */
/*  collections                                                               */
/* -------------------------------------------------------------------------- */

function talonRef(db: Firestore, siteId: string, talonId: string) {
  return db.collection('sites').doc(siteId).collection('talons').doc(talonId);
}

function talonRunsCollection(db: Firestore, siteId: string) {
  return db.collection('sites').doc(siteId).collection('talon_runs');
}

function machinesCollection(db: Firestore, siteId: string) {
  return db.collection('sites').doc(siteId).collection('machines');
}

/* -------------------------------------------------------------------------- */
/*  descriptions                                                              */
/* -------------------------------------------------------------------------- */

/** Lowercase one-liner describing why the talon fired, stored on every run. */
export function describeTrigger(trigger: TalonTrigger): string {
  switch (trigger.type) {
    case 'schedule': {
      if (typeof trigger.intervalMinutes === 'number') {
        return `every ${trigger.intervalMinutes} minutes`;
      }
      const entries = trigger.entries ?? [];
      if (entries.length === 1) {
        return `scheduled ${entries[0].days.join('/')} at ${entries[0].time}`;
      }
      return `scheduled (${entries.length} times)`;
    }
    case 'threshold':
      return `${trigger.metric} ${trigger.operator} ${trigger.value}`;
    case 'event':
      return `on ${trigger.eventTypes.join(', ')}`;
  }
}

/* -------------------------------------------------------------------------- */
/*  entry points                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Execute a talon.
 *
 * @returns one summary per run recorded — empty when a guard stopped the talon
 *          before any run existed (disabled, or still cooling down).
 */
export async function runTalon(
  db: Firestore,
  talon: StoredTalon,
  context: TalonRunContext,
): Promise<TalonRunSummary[]> {
  const { siteId } = context;
  const now = context.now ?? new Date();

  // A disabled talon never runs, not even on demand: "run now" on a talon the
  // operator just switched off would be a surprising thing for a button to do.
  if (!talon.enabled) return [];

  if (!context.manual && isCoolingDown(talon, now)) return [];

  const inFlight = await claimInFlight(db, siteId, talon, now);
  if (inFlight) return [inFlight];

  const site = await readSite(db, siteId);
  const needsMachines =
    talon.condition.type === 'visual_check' ||
    talon.outputs.some((output) => output.type === 'command');
  const targets = needsMachines ? await resolveTargets(db, siteId, talon.scope.machineIds) : [];

  const env: RunEnvironment = {
    db,
    siteId,
    siteName: site.name,
    siteLabel: site.label,
    baseUrl: resolveBaseUrl(),
    // One memo per execution: a machine-scoped talon with a webhook output
    // would otherwise re-read the owner's billing state once per machine.
    billingCache: createWebhookBillingCache(),
    triggerSummary: context.triggerSummary ?? describeTrigger(talon.trigger),
    manual: context.manual === true,
    now,
    targetMachineIds: targets.map((target) => target.id),
  };

  const summaries: TalonRunSummary[] = [];

  if (talon.condition.type === 'visual_check') {
    for (const target of targets) {
      // Sequential: the agent throttles `capture_screenshot` to one per 5s per
      // machine, and a shared site llm key is happier not being hit N-wide.
      summaries.push(
        target.online
          ? await executeRun(env, talon, target)
          : await recordTerminalRun(env, talon, 'skipped', 'machine_offline', target),
      );
    }
  } else {
    const machine = context.machineId
      ? await readMachine(db, siteId, context.machineId)
      : undefined;
    summaries.push(await executeRun(env, talon, machine));
  }

  await settleTalon(db, siteId, talon, summaries, now);
  return summaries;
}

/**
 * Run a talon on demand. Bypasses the cooldown — an operator pressing "run now"
 * has decided the cooldown does not apply — and stamps `manual` on the run so
 * the run list distinguishes it from a scheduled fire.
 *
 * @throws {TalonStoreError} 404 when the site has no talon with that id.
 */
export async function runTalonManual(
  db: Firestore,
  siteId: string,
  talonId: string,
  actor: Actor,
): Promise<TalonRunSummary[]> {
  const talon = await getTalon(db, siteId, talonId);
  if (!talon) {
    throw new TalonStoreError(404, 'talon_not_found', `talon \`${talonId}\` was not found.`);
  }

  logger.info(`Talon manual run: ${talonId} on ${siteId} by ${describeActor(actor)}`, {
    context: 'talons/engine',
  });

  return runTalon(db, talon, { siteId, manual: true, triggerSummary: 'manual run' });
}

function describeActor(actor: Actor): string {
  return actor.type === 'user' ? `user:${actor.userId}` : `system:${actor.name}`;
}

/* -------------------------------------------------------------------------- */
/*  guards                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Cooldown applies to threshold and event triggers only. A schedule trigger
 * already carries its own spacing in `nextRunAt`, and applying the cooldown to
 * it too would silently drop fires from a schedule whose interval is shorter
 * than the (independently configured) cooldown.
 */
function isCoolingDown(talon: StoredTalon, now: Date): boolean {
  if (talon.trigger.type === 'schedule') return false;
  if (talon.cooldownMinutes <= 0) return false;
  const lastRunMs = timestampToMs(talon.lastRunAt);
  if (lastRunMs === null) return false;
  return now.getTime() - lastRunMs < talon.cooldownMinutes * 60_000;
}

/**
 * Enforce one in-flight run per talon.
 *
 * A run still inside {@link STALE_RUN_MS} wins: this execution records a
 * `skipped` run and stops. An older one is presumed dead (the process that
 * owned it was killed or redeployed mid-run), so it is closed out as
 * `failed`/`stale` and this execution proceeds — otherwise a single crash would
 * wedge the talon permanently.
 *
 * @returns the recorded skip when another run holds the slot, else `null`.
 */
async function claimInFlight(
  db: Firestore,
  siteId: string,
  talon: StoredTalon,
  now: Date,
): Promise<TalonRunSummary | null> {
  const snapshot = await talonRunsCollection(db, siteId)
    .where('talonId', '==', talon.id)
    .where('status', '==', 'running')
    .get();

  let blocked = false;
  for (const doc of snapshot.docs) {
    const startedMs = timestampToMs((doc.data() as TalonRunDoc).startedAt);
    const fresh = startedMs !== null && now.getTime() - startedMs < STALE_RUN_MS;
    if (fresh) {
      blocked = true;
      continue;
    }
    await doc.ref.update({
      status: 'failed',
      error: 'stale',
      completedAt: now,
      ...(startedMs !== null ? { durationMs: now.getTime() - startedMs } : {}),
    });
    logger.warn(`Talon run ${doc.id} was stale and has been closed out`, {
      context: 'talons/engine',
      data: { siteId, talonId: talon.id },
    });
  }

  if (!blocked) return null;

  // The talon bookkeeping is deliberately NOT touched here: the run holding
  // the slot is still going and will stamp `lastRunAt` itself when it lands.
  return recordTerminalRun(
    { db, siteId, triggerSummary: describeTrigger(talon.trigger), manual: false, now },
    talon,
    'skipped',
    'already_running',
  );
}

/* -------------------------------------------------------------------------- */
/*  reads                                                                     */
/* -------------------------------------------------------------------------- */

/** Site name + the `"name (siteId)"` label alert emails show, in one read. */
async function readSite(db: Firestore, siteId: string): Promise<{ name: string; label: string }> {
  try {
    const snapshot = await db.collection('sites').doc(siteId).get();
    const name = (snapshot.data()?.name as string | undefined)?.trim();
    if (!name || name === siteId) return { name: siteId, label: siteId };
    return { name, label: `${name} (${siteId})` };
  } catch {
    return { name: siteId, label: siteId };
  }
}

async function readMachine(
  db: Firestore,
  siteId: string,
  machineId: string,
): Promise<TargetMachine | undefined> {
  try {
    const snapshot = await machinesCollection(db, siteId).doc(machineId).get();
    if (!snapshot.exists) return undefined;
    const data = snapshot.data() ?? {};
    return {
      id: machineId,
      name: (data.name as string | undefined) || machineId,
      online: data.online === true,
    };
  } catch {
    return undefined;
  }
}

/** The talon's scope resolved to real machines — its explicit list, or the whole site. */
async function resolveTargets(
  db: Firestore,
  siteId: string,
  machineIds: string[] | null,
): Promise<TargetMachine[]> {
  if (machineIds !== null) {
    const resolved: TargetMachine[] = [];
    for (const machineId of machineIds) {
      const machine = await readMachine(db, siteId, machineId);
      // A machine that was removed from the site after the talon was authored
      // is not a run with no target — it is simply no longer in scope.
      if (machine) resolved.push(machine);
    }
    return resolved;
  }

  const snapshot = await machinesCollection(db, siteId).get();
  return snapshot.docs.map((doc) => {
    const data = doc.data() ?? {};
    return {
      id: doc.id,
      name: (data.name as string | undefined) || doc.id,
      online: data.online === true,
    };
  });
}

/* -------------------------------------------------------------------------- */
/*  run recording                                                             */
/* -------------------------------------------------------------------------- */

function baseRunDoc(
  env: RunRecordEnv,
  talon: StoredTalon,
  machine: TargetMachine | undefined,
  correlationId: string,
): TalonRunDoc {
  return {
    talonId: talon.id,
    talonName: talon.name,
    triggerType: talon.trigger.type,
    triggerSummary: env.triggerSummary,
    ...(machine ? { machineId: machine.id, machineName: machine.name } : {}),
    status: 'running',
    startedAt: env.now,
    outputs: [],
    correlationId,
    ...(talon.chatId ? { chatId: talon.chatId } : {}),
    ...(env.manual ? { manual: true } : {}),
  };
}

/** A run that is over before it starts — recorded whole, in one write. */
async function recordTerminalRun(
  env: RunRecordEnv,
  talon: StoredTalon,
  status: TalonRunStatus,
  error: string,
  machine?: TargetMachine,
): Promise<TalonRunSummary> {
  const ref = talonRunsCollection(env.db, env.siteId).doc();
  await ref.set({
    ...baseRunDoc(env, talon, machine, generateCorrelationId()),
    status,
    error,
    completedAt: env.now,
    durationMs: 0,
  });

  await writeRunLog(env, talon, status, machine, error);
  return { runId: ref.id, status, machineId: machine?.id, outputs: [], error };
}

/**
 * Execute one run end to end: create the record, evaluate the condition, fire
 * the outputs in order, finalize.
 */
async function executeRun(
  env: RunEnvironment,
  talon: StoredTalon,
  machine: TargetMachine | undefined,
): Promise<TalonRunSummary> {
  const correlationId = generateCorrelationId();
  const ref = talonRunsCollection(env.db, env.siteId).doc();
  await ref.set(baseRunDoc(env, talon, machine, correlationId));
  await writeRunLog(env, talon, 'running', machine);

  const startedMs = Date.now();

  let condition: TalonRunCondition | undefined;
  let conditionForOutputs: TalonRunCondition | undefined;

  if (talon.condition.type === 'visual_check' && machine) {
    try {
      const result = await evaluateVisualCheck(
        env.db,
        env.siteId,
        machine.id,
        talon.condition,
        correlationId,
      );
      condition = {
        type: 'visual_check',
        verdict: result.verdict,
        confidence: result.confidence,
        reason: result.reason,
        // PATH only. Signed capture urls expire in ~1h and the bucket lifecycle
        // deletes the object at 30 days, so persisting the url would leave a
        // dead link on a run record that outlives both.
        ...(result.screenshotPath ? { screenshotPath: result.screenshotPath } : {}),
      };
      conditionForOutputs = result.screenshotUrl
        ? { ...condition, screenshotUrl: result.screenshotUrl }
        : condition;
    } catch (error) {
      return finalizeConditionError(env, talon, machine, ref, startedMs, error);
    }
  }

  let outputs: TalonRunOutput[];
  if (condition && condition.verdict === 'pass') {
    // The expectation held, so there is nothing to react to. Recorded per
    // output rather than as an empty list so the run reads the same shape
    // whether the outputs ran or not.
    outputs = talon.outputs.map((output) => ({
      type: output.type,
      status: 'skipped' as const,
      detail: 'condition_passed',
    }));
  } else {
    const outputCtx: TalonOutputContext = {
      db: env.db,
      siteId: env.siteId,
      siteLabel: env.siteLabel,
      siteName: env.siteName,
      talon,
      talonId: talon.id,
      talonName: talon.name,
      triggerSummary: env.triggerSummary,
      runId: ref.id,
      correlationId,
      ...(machine ? { machineId: machine.id, machineName: machine.name } : {}),
      // A machine-scoped run drives its command outputs at its own machine;
      // a site-level run fans them out across the talon's scope.
      targetMachineIds: machine ? [machine.id] : env.targetMachineIds,
      ...(conditionForOutputs ? { condition: conditionForOutputs } : {}),
      baseUrl: env.baseUrl,
      billingCache: env.billingCache,
      now: env.now,
    };

    outputs = [];
    for (const output of talon.outputs) {
      // Sequential and individually recorded: one output failing must never
      // stop the rest, and the run has to say which one failed.
      outputs.push(await executeTalonOutput(outputCtx, output));
    }
  }

  const status: TalonRunStatus = outputs.some((output) => output.status === 'failed')
    ? 'failed'
    : 'succeeded';

  // A hoot output opens a fresh chat per run and reports it as its `detail`.
  // That conversation is what an operator wants to open FROM this run, so it
  // takes the run's `chatId` over the talon's authoring chat, which is a
  // property of the talon and is already on the talon document.
  const hootChatId = findHootChatId(outputs);

  await ref.update({
    status,
    outputs,
    ...(condition ? { condition } : {}),
    ...(hootChatId ? { chatId: hootChatId } : {}),
    completedAt: env.now,
    durationMs: Date.now() - startedMs,
  });

  await writeRunLog(env, talon, status, machine, summarizeOutputs(outputs));
  return {
    runId: ref.id,
    status,
    machineId: machine?.id,
    outputs,
    ...(condition ? { condition } : {}),
  };
}

/**
 * Close out a run whose condition could not produce a verdict.
 *
 * `machine_offline` and `no_interactive_session` describe a machine that was
 * not in a state to be checked — nothing is wrong with the talon, so those are
 * `skipped` and do not count toward auto-disable. `capture_failed` and
 * `verdict_error` are genuine faults and fail the run.
 */
async function finalizeConditionError(
  env: RunEnvironment,
  talon: StoredTalon,
  machine: TargetMachine | undefined,
  ref: DocumentReference,
  startedMs: number,
  error: unknown,
): Promise<TalonRunSummary> {
  const code = error instanceof TalonVisualCheckError ? error.code : 'verdict_error';
  const benign = code === 'machine_offline' || code === 'no_interactive_session';
  const status: TalonRunStatus = benign ? 'skipped' : 'failed';
  const detail = benign
    ? code
    : `${code}: ${error instanceof Error ? error.message : String(error)}`;

  await ref.update({
    status,
    error: detail,
    completedAt: env.now,
    durationMs: Date.now() - startedMs,
  });

  await writeRunLog(env, talon, status, machine, detail);
  return { runId: ref.id, status, machineId: machine?.id, outputs: [], error: detail };
}

/**
 * The chat a `cortex` output dispatched its turn into, if one landed. Only a
 * `sent` entry carries a chat id — a failed hoot output's `detail` is a failure
 * reason, and stamping that on the run as a chat id would produce a dead link.
 *
 * `outputs` may legitimately hold more than one cortex entry (nothing makes
 * output types unique), and each one opens its own chat. The run doc has a
 * single `chatId`, so the first dispatched chat is the one it points at; the
 * rest are still fully recorded in `outputs[].detail`.
 */
function findHootChatId(outputs: TalonRunOutput[]): string | undefined {
  const hoot = outputs.find((output) => output.type === 'cortex' && output.status === 'sent');
  return hoot?.detail;
}

function summarizeOutputs(outputs: TalonRunOutput[]): string {
  if (outputs.length === 0) return 'no outputs';
  return outputs
    .map((output) => `${output.type}: ${output.status}${output.detail ? ` (${output.detail})` : ''}`)
    .join('; ');
}

/* -------------------------------------------------------------------------- */
/*  companion logs                                                            */
/* -------------------------------------------------------------------------- */

const LOG_ACTION_BY_STATUS: Readonly<
  Record<TalonRunStatus, { action: string; level: 'info' | 'warning' | 'error' }>
> = {
  running: { action: 'talon_triggered', level: 'info' },
  succeeded: { action: 'talon_succeeded', level: 'info' },
  failed: { action: 'talon_failed', level: 'error' },
  skipped: { action: 'talon_skipped', level: 'warning' },
  missed: { action: 'talon_skipped', level: 'warning' },
};

/**
 * Mirror the run into `sites/{siteId}/logs`, the feed operators actually watch.
 *
 * `timestamp`, `action`, `level`, and `machineId` are ALL required by
 * firestore.rules (`hasRequiredFields`, line 471) — a write missing any one of
 * them is rejected outright. A site-level run has no machine, so it writes the
 * `'site'` sentinel rather than omitting the field.
 *
 * Best-effort: a log write that fails must not fail the run it describes.
 */
async function writeRunLog(
  env: RunRecordEnv,
  talon: StoredTalon,
  status: TalonRunStatus,
  machine: TargetMachine | undefined,
  details?: string,
): Promise<void> {
  const { action, level } = LOG_ACTION_BY_STATUS[status];
  try {
    await env.db
      .collection('sites')
      .doc(env.siteId)
      .collection('logs')
      .add({
        timestamp: env.now,
        action,
        level,
        machineId: machine?.id ?? SITE_LOG_SENTINEL,
        machineName: machine?.name ?? SITE_LOG_SENTINEL,
        details: details
          ? `${talon.name} — ${env.triggerSummary} — ${details}`
          : `${talon.name} — ${env.triggerSummary}`,
      });
  } catch (error) {
    logger.warn(`Talon companion log write failed for ${talon.id}`, {
      context: 'talons/engine',
      data: { siteId: env.siteId, error: String(error) },
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  bookkeeping                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Denormalize the execution onto the talon document and apply the auto-disable
 * backoff. One write per execution, not per run: a machine-scoped talon over
 * twelve machines is still one thing that happened once.
 *
 * The execution's status is the worst of its runs — a talon that failed on one
 * of four machines has a problem, and a card that reads "succeeded" would hide it.
 */
async function settleTalon(
  db: Firestore,
  siteId: string,
  talon: StoredTalon,
  summaries: TalonRunSummary[],
  now: Date,
): Promise<void> {
  if (summaries.length === 0) return;

  const status: TalonRunStatus = summaries.some((summary) => summary.status === 'failed')
    ? 'failed'
    : summaries.some((summary) => summary.status === 'succeeded')
      ? 'succeeded'
      : 'skipped';

  let consecutiveFailures = talon.consecutiveFailures ?? 0;
  if (status === 'failed') consecutiveFailures += 1;
  else if (status === 'succeeded') consecutiveFailures = 0;
  // A skipped execution leaves the counter alone: it neither proved the talon
  // works nor proved it doesn't.

  const disable = consecutiveFailures >= AUTO_DISABLE_AFTER_FAILURES;
  const updates: Record<string, unknown> = {
    lastRunAt: now,
    lastRunStatus: status,
    lastRunId: summaries[summaries.length - 1].runId,
    consecutiveFailures,
    ...(disable ? { enabled: false, updatedAt: now } : {}),
  };

  await talonRef(db, siteId, talon.id).update(updates);

  if (!disable) return;

  emitMutation({
    kind: 'talon_mutated',
    siteId,
    actor: 'system:talon_runner',
    targetId: talon.id,
    attributes: {
      verb: 'talon.disable',
      endpoint: `/api/sites/${siteId}/talons/${talon.id}`,
      method: 'PATCH',
      changedFields: ['enabled'],
      reason: 'consecutive_failures',
      consecutiveFailures,
    },
  });

  logger.warn(
    `Talon ${talon.id} disabled after ${consecutiveFailures} consecutive failed runs`,
    { context: 'talons/engine', data: { siteId } },
  );
}
