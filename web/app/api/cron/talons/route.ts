/**
 * GET /api/cron/talons — the schedule sweep (talons wave 2, task 2.2).
 *
 * Runs once a minute on cron-job.org (NOT Railway — see
 * `docs/internal/runbooks/talons.md`) and is the only thing that fires a
 * schedule-triggered talon. Threshold and event talons are driven by incoming
 * data and never appear here.
 *
 * Authentication: `X-Cron-Secret` must match `CRON_SECRET`, per-environment.
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
import { getSiteTimezone, type StoredTalon } from '@/lib/talons/store.server';
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
 * How late a schedule may fire before it is written off. Wider than a normal
 * hiccup (a slow sweep, one skipped minute) and narrower than any outage worth
 * noticing, which is also where the `talon_dispatch` health component starts
 * reporting degraded.
 */
const MISSED_FIRE_GRACE_MS = 10 * 60_000;

/** Stale `running` runs closed out per sweep. */
const STALE_RUN_SCAN_LIMIT = 50;

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

    return NextResponse.json({ ok: true, due, executed, missed, deferred, staleRecovered });
  } catch (error) {
    return apiError(error, 'cron/talons');
  }
}
