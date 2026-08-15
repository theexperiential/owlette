/**
 * GET /api/cron/talons — the schedule sweep (talons wave 2, task 2.2).
 *
 * Runs once a minute on cron-job.org (NOT Railway — see
 * `docs/internal/runbooks/talons.md`) and is the only thing that fires a
 * schedule-triggered talon. Threshold talons are driven by incoming data and
 * never appear here; nor do event talons, EXCEPT the delayed ones — see below.
 *
 * Authentication: `X-Cron-Secret` must match `CRON_SECRET`, per-environment.
 *
 * ## Two dispatch passes
 *
 * Deferrals first, then schedules. An event trigger carrying a `delayMinutes`
 * is written by the matcher as a `pending` `talon_runs` document with a
 * `runAfterAt`, and this route is what fires it. It goes first because a
 * deferral past {@link MISSED_FIRE_GRACE_MS} is written off PERMANENTLY,
 * whereas a schedule this sweep runs out of budget for keeps its `nextRunAt`
 * and is claimed by the next minute's sweep.
 *
 * The deferral pass is fault-isolated for the same reason the janitor is: its
 * collection-group index (`status` ASC, `runAfterAt` ASC) has to be deployed
 * before the code that queries it, and a still-building index must not take
 * schedule dispatch down with it.
 *
 * ## Claiming is transactional
 *
 * Two overlapping sweeps (a slow run still working while the next minute
 * starts, or both origins behind the load balancer being hit) must never fire
 * the same talon twice. A talon is therefore CLAIMED inside a transaction that
 * re-reads it, verifies it is still enabled and still due, and advances
 * `nextRunAt` in the same commit. The loser of that race sees an advanced
 * `nextRunAt` and skips silently — no run, no log, nothing to explain.
 *
 * ## A stalled sweep must not fire a burst on recovery
 *
 * The scheduler's most important safety property, inherited from the reboot
 * scheduler: if the cron is down for an hour, the talons that came due in that
 * hour are NOT all executed the moment it returns. Anything more than
 * {@link MISSED_FIRE_GRACE_MS} late is recorded as a `missed` run and skipped,
 * and its `nextRunAt` is advanced to the next real slot. Twelve machines do not
 * get rebooted at once because a deploy took a while.
 *
 * ## Caps
 *
 * At most {@link MAX_CLAIMS_PER_SWEEP} talons are claimed per sweep and no new
 * talon is claimed past {@link SWEEP_BUDGET_MS}. Leftovers keep their untouched
 * `nextRunAt`, so the next minute's sweep picks them up exactly where this one
 * stopped; they are reported as `deferred` rather than silently dropped.
 */
import { NextRequest, NextResponse } from 'next/server';
import { FieldValue, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import { apiError } from '@/lib/apiErrorResponse';
import { generateCorrelationId } from '@/lib/auditLog.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { timestampToMs } from '@/lib/firestoreTime.server';
import logger from '@/lib/logger';
import { runTalon, STALE_RUN_MS } from '@/lib/talons/engine.server';
import { computeNextRunAt } from '@/lib/talons/schedule.server';
import { getSiteTimezone, getTalon, type StoredTalon } from '@/lib/talons/store.server';
import type { TalonDoc, TalonRunDoc } from '@/lib/talons/types';

/**
 * Talons claimed per sweep. At a one-minute cadence this is a fleet-wide budget
 * of 25 executions/minute; a backlog drains across subsequent sweeps rather
 * than in one request that would outlive its own HTTP timeout.
 */
const MAX_CLAIMS_PER_SWEEP = 25;

/**
 * Wall-clock budget for claiming. Comfortably inside the 60s cadence so a sweep
 * finishes before its successor starts, and inside cron-job.org's request
 * timeout so the response is actually read.
 */
const SWEEP_BUDGET_MS = 50_000;

/**
 * How late a schedule — or a deferred event trigger — may fire before it is
 * written off. Wider than a normal hiccup (a slow sweep, one skipped minute)
 * and narrower than any outage worth noticing, which is also where the
 * `talon_dispatch` health component starts reporting degraded.
 */
const MISSED_FIRE_GRACE_MS = 10 * 60_000;

/** Stale `running` runs closed out per sweep. */
const STALE_RUN_SCAN_LIMIT = 50;

/**
 * Deferrals fired per sweep. Same budget and the same reasoning as
 * {@link MAX_CLAIMS_PER_SWEEP} — leftovers stay `pending`, keep their
 * `runAfterAt`, and are claimed next minute while still inside their grace.
 */
const MAX_DEFERRAL_CLAIMS_PER_SWEEP = 25;

/** Recorded as the trigger summary on every run this sweep produces. */
const SCHEDULE_TRIGGER_SUMMARY = 'schedule';

/** A talon this sweep owns, and the instant it was due at before the claim. */
interface TalonClaim {
  talon: StoredTalon;
  dueAtMs: number;
}

function talonRunsCollection(db: Firestore, siteId: string) {
  return db.collection('sites').doc(siteId).collection('talon_runs');
}

/**
 * Take ownership of a due talon and re-arm it, atomically.
 *
 * @returns the claim, or `null` when this sweep must NOT execute the talon —
 *          it was disabled, deleted, already claimed by a concurrent sweep, or
 *          its trigger is no longer a schedule.
 */
async function claimDueTalon(
  db: Firestore,
  ref: DocumentReference,
  timezone: string,
  now: Date,
): Promise<TalonClaim | null> {
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const data = snapshot.exists ? (snapshot.data() as TalonDoc | undefined) : undefined;
    // Disabled or deleted between the collection-group query and the claim.
    if (!data || data.enabled !== true) return null;

    const dueAtMs = timestampToMs(data.nextRunAt);
    // Someone else already advanced it. Losing this race is a normal outcome,
    // not an error: the winner is running the talon right now.
    if (dueAtMs === null || dueAtMs > now.getTime()) return null;

    const nextRunAt = computeNextRunAt(data.trigger, timezone, now);
    if (!nextRunAt) {
      // The trigger was edited away from a schedule while a stale `nextRunAt`
      // was left behind (or the schedule has no reachable slot). Drop the
      // field, or it matches `nextRunAt <= now` on every sweep forever.
      transaction.update(ref, { nextRunAt: FieldValue.delete() });
      return null;
    }

    transaction.update(ref, { nextRunAt });
    return { talon: { id: ref.id, ...data }, dueAtMs };
  });
}

/**
 * Record a fire that was skipped for being too far past its slot.
 *
 * Written as a real run so the operator sees WHY nothing happened at 03:00 —
 * an absent run reads identically to a talon nobody configured.
 */
async function recordMissedRun(
  db: Firestore,
  siteId: string,
  talon: StoredTalon,
  now: Date,
): Promise<void> {
  const run: TalonRunDoc = {
    talonId: talon.id,
    talonName: talon.name,
    triggerType: 'schedule',
    triggerSummary: SCHEDULE_TRIGGER_SUMMARY,
    status: 'missed',
    startedAt: now,
    completedAt: now,
    durationMs: 0,
    outputs: [],
    correlationId: generateCorrelationId(),
    error: 'missed_fire_window',
    ...(talon.chatId ? { chatId: talon.chatId } : {}),
  };

  await talonRunsCollection(db, siteId).add(run);
}

/* -------------------------------------------------------------------------- */
/*  deferred event triggers                                                   */
/* -------------------------------------------------------------------------- */

/** What one sweep did with the deferrals that came due. */
interface DeferralSweepCounts {
  due: number;
  fired: number;
  missed: number;
  skipped: number;
}

/** A deferral this sweep owns, and what it is allowed to do with it. */
interface DeferralClaim {
  outcome: 'fire' | 'missed';
  deferral: TalonRunDoc;
}

/**
 * Take ownership of one due deferral, atomically.
 *
 * The same race the schedule claim guards against, on the other document: two
 * overlapping sweeps must not both fire the wait a talon has been holding. The
 * status flip out of `pending` IS the claim, so the loser re-reads a document
 * that is no longer pending and returns empty-handed.
 *
 * `missed` is the deferral's half of the scheduler's stalled-sweep property: a
 * deferral more than {@link MISSED_FIRE_GRACE_MS} past its instant is written
 * off in the same transaction rather than executed. A restart talon that was
 * supposed to look at the wall three minutes after a crash is not something to
 * carry out forty minutes later, when the fleet has moved on.
 *
 * @returns the claim, or `null` when another sweep already resolved it.
 */
async function claimDueDeferral(
  db: Firestore,
  ref: DocumentReference,
  now: Date,
): Promise<DeferralClaim | null> {
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const data = snapshot.exists ? (snapshot.data() as TalonRunDoc | undefined) : undefined;
    if (!data || data.status !== 'pending') return null;

    const runAfterMs = timestampToMs(data.runAfterAt);
    // Not actually due. Unreachable through the query (which orders on
    // `runAfterAt`, so a document missing it is excluded) — this is the guard
    // against a stale query result, and leaving it pending is the safe answer.
    if (runAfterMs === null || runAfterMs > now.getTime()) return null;

    if (now.getTime() - runAfterMs > MISSED_FIRE_GRACE_MS) {
      transaction.update(ref, {
        status: 'missed',
        error: 'missed_fire_window',
        completedAt: now,
        durationMs: 0,
      });
      return { outcome: 'missed', deferral: data };
    }

    transaction.update(ref, { status: 'fired', firedAt: now });
    return { outcome: 'fire', deferral: data };
  });
}

/**
 * Run the talon a claimed deferral was waiting for, and close the crumb out.
 *
 * The talon is re-read rather than reconstructed from the deferral: minutes
 * have passed since the event, and it may have been edited, switched off, or
 * deleted in the meantime. A deferral is a promise to reconsider running, not
 * a promise to run.
 *
 * An empty summary list means the engine's cooldown gate stopped it — the one
 * outcome that records nothing of its own (see `runTalon`) — so the crumb is
 * where that fact has to live, or an operator sees a deferral fire into
 * silence.
 *
 * @returns which counter this deferral belongs in.
 */
async function fireClaimedDeferral(
  db: Firestore,
  siteId: string,
  ref: DocumentReference,
  deferral: TalonRunDoc,
  now: Date,
): Promise<'fired' | 'skipped'> {
  const talon = await getTalon(db, siteId, deferral.talonId);
  if (!talon || talon.enabled !== true) {
    await ref.update({
      status: 'skipped',
      error: talon ? 'talon_disabled' : 'talon_deleted',
      completedAt: now,
      durationMs: 0,
    });
    return 'skipped';
  }

  const startedMs = Date.now();
  const summaries = await runTalon(db, talon, {
    siteId,
    ...(deferral.machineId ? { machineId: deferral.machineId } : {}),
    triggerSummary: deferral.triggerSummary,
  });

  const completedAt = new Date();
  await ref.update({
    ...(summaries.length === 0 ? { status: 'skipped', error: 'cooldown' } : {}),
    firedRunIds: summaries.map((summary) => summary.runId),
    completedAt,
    // The wait is not work, so the crumb times the FIRE, not the delay it sat
    // through — otherwise every three-minute deferral would read as a
    // three-minute run.
    durationMs: completedAt.getTime() - startedMs,
  });

  return summaries.length === 0 ? 'skipped' : 'fired';
}

/**
 * Fire every deferral whose wait has expired.
 *
 * Backed by the `talon_runs` collection-group index (`status` ASC,
 * `runAfterAt` ASC) declared in firestore.indexes.json. Oldest first, so a
 * backlog drains in the order the events actually happened.
 */
async function fireDueDeferrals(
  db: Firestore,
  now: Date,
  deadline: number,
): Promise<DeferralSweepCounts> {
  const snapshot = await db
    .collectionGroup('talon_runs')
    .where('status', '==', 'pending')
    .where('runAfterAt', '<=', now)
    .orderBy('runAfterAt', 'asc')
    .limit(MAX_DEFERRAL_CLAIMS_PER_SWEEP)
    .get();

  const counts: DeferralSweepCounts = {
    due: snapshot.docs.length,
    fired: 0,
    missed: 0,
    skipped: 0,
  };

  for (const doc of snapshot.docs) {
    // Everything from here on stays `pending` with its `runAfterAt` untouched,
    // so the next sweep claims it — still inside the grace window.
    if (Date.now() >= deadline) {
      logger.warn('Talon deferral pass hit the sweep budget with work left', {
        context: 'cron/talons',
      });
      break;
    }

    const siteId = doc.ref.parent.parent?.id;
    if (!siteId) {
      logger.warn(`Talon deferral ${doc.id} has no parent site — skipping`, {
        context: 'cron/talons',
      });
      continue;
    }

    try {
      const claim = await claimDueDeferral(db, doc.ref, now);
      if (!claim) continue;

      if (claim.outcome === 'missed') {
        counts.missed += 1;
        logger.warn(
          `Talon deferral ${doc.id} missed its window — not executing ${claim.deferral.talonId}`,
          { context: 'cron/talons', data: { siteId } },
        );
        continue;
      }

      const outcome = await fireClaimedDeferral(db, siteId, doc.ref, claim.deferral, now);
      counts[outcome] += 1;
    } catch (error) {
      // One deferral's failure must not abort the pass, for the same reason one
      // talon's does not abort the schedule sweep.
      logger.error(`Talon deferral failed for ${siteId}/${doc.id}`, {
        context: 'cron/talons',
        data: { error: String(error) },
      });
    }
  }

  return counts;
}

/**
 * Close out runs abandoned mid-flight (the process that owned them was killed
 * or redeployed). The engine's in-flight guard clears these when the SAME talon
 * next executes; this covers the talon that never executes again — a run stuck
 * `running` would otherwise block it indefinitely and sit in the run list as a
 * permanent "in progress".
 *
 * @returns how many runs were closed out.
 */
async function recoverStaleRuns(db: Firestore, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_RUN_MS);
  const snapshot = await db
    .collectionGroup('talon_runs')
    .where('status', '==', 'running')
    .where('startedAt', '<=', cutoff)
    .limit(STALE_RUN_SCAN_LIMIT)
    .get();

  let recovered = 0;
  for (const doc of snapshot.docs) {
    const startedMs = timestampToMs((doc.data() as TalonRunDoc).startedAt);
    try {
      await doc.ref.update({
        status: 'failed',
        error: 'stale',
        completedAt: now,
        ...(startedMs !== null ? { durationMs: now.getTime() - startedMs } : {}),
      });
      recovered += 1;
    } catch (error) {
      logger.warn(`Talon run ${doc.id} could not be closed out as stale`, {
        context: 'cron/talons',
        data: { error: String(error) },
      });
    }
  }

  return recovered;
}

export async function GET(request: NextRequest) {
  const cronSecret = request.headers.get('x-cron-secret');
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getAdminDb();
  const now = new Date();
  const deadline = Date.now() + SWEEP_BUDGET_MS;

  // The janitor runs FIRST and outside the sweep's error path. A wedged run
  // blocks its talon's next execution, so recovery must not queue behind this
  // sweep's own work — and a janitor failure (most likely its collection-group
  // index still building) must not take dispatch down with it.
  let staleRecovered = 0;
  try {
    staleRecovered = await recoverStaleRuns(db, now);
  } catch (error) {
    logger.error('Talon stale-run recovery failed', {
      context: 'cron/talons',
      data: { error: String(error) },
    });
  }

  // Deferrals before schedules, and isolated from them: a deferral that misses
  // its grace window is gone for good, while a schedule left unclaimed is only
  // late by a minute. See the two-pass note at the top of the file.
  let deferrals: DeferralSweepCounts = { due: 0, fired: 0, missed: 0, skipped: 0 };
  try {
    deferrals = await fireDueDeferrals(db, now, deadline);
  } catch (error) {
    logger.error('Talon deferral dispatch failed', {
      context: 'cron/talons',
      data: { error: String(error) },
    });
  }

  try {
    const dueSnapshot = await db
      .collectionGroup('talons')
      .where('enabled', '==', true)
      .where('nextRunAt', '<=', now)
      .orderBy('nextRunAt', 'asc')
      .limit(MAX_CLAIMS_PER_SWEEP)
      .get();

    const due = dueSnapshot.docs.length;
    // One timezone read per site per sweep, not per talon.
    const timezones = new Map<string, string>();
    let executed = 0;
    let missed = 0;
    let deferred = 0;

    for (let index = 0; index < dueSnapshot.docs.length; index++) {
      if (Date.now() >= deadline) {
        // Everything from here on keeps its untouched `nextRunAt` and is still
        // due next minute.
        deferred = due - index;
        logger.warn(`Talon sweep hit its ${SWEEP_BUDGET_MS}ms budget with ${deferred} talon(s) left`, {
          context: 'cron/talons',
        });
        break;
      }

      const doc = dueSnapshot.docs[index];
      const siteId = doc.ref.parent.parent?.id;
      if (!siteId) {
        logger.warn(`Talon ${doc.id} has no parent site — skipping`, { context: 'cron/talons' });
        continue;
      }

      try {
        let timezone = timezones.get(siteId);
        if (timezone === undefined) {
          timezone = await getSiteTimezone(db, siteId);
          timezones.set(siteId, timezone);
        }

        const claim = await claimDueTalon(db, doc.ref, timezone, now);
        if (!claim) continue;

        if (now.getTime() - claim.dueAtMs > MISSED_FIRE_GRACE_MS) {
          await recordMissedRun(db, siteId, claim.talon, now);
          missed += 1;
          logger.warn(
            `Talon ${claim.talon.id} missed its window by ` +
              `${Math.round((now.getTime() - claim.dueAtMs) / 60_000)}m — not executing`,
            { context: 'cron/talons', data: { siteId } },
          );
          continue;
        }

        await runTalon(db, claim.talon, { siteId, triggerSummary: SCHEDULE_TRIGGER_SUMMARY });
        executed += 1;
      } catch (error) {
        // One talon's failure must never abort the sweep — the rest of the
        // fleet's schedules are unrelated to whatever went wrong here.
        logger.error(`Talon sweep failed for ${siteId}/${doc.id}`, {
          context: 'cron/talons',
          data: { error: String(error) },
        });
      }
    }

    // `deferred` is the schedule pass's leftovers — talons this sweep ran out
    // of budget for. The `deferred*` block is the delayed-event pass, and the
    // two are unrelated.
    return NextResponse.json({
      ok: true,
      due,
      executed,
      missed,
      deferred,
      staleRecovered,
      deferredDue: deferrals.due,
      deferredFired: deferrals.fired,
      deferredMissed: deferrals.missed,
      deferredSkipped: deferrals.skipped,
    });
  } catch (error) {
    return apiError(error, 'cron/talons');
  }
}
