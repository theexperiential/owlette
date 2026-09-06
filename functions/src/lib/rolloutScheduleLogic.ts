/**
 * Pure decisions for the scheduled-rollout sweep (`rolloutScheduler.ts`), split
 * out so every branch is unit-testable without firebase-admin or an emulator.
 *
 * A rollout created by `POST /api/roosts/{id}/deploy` with a future `scheduleAt`
 * is parked at `stage: 'scheduled'` with its canary/fleet split, versionUrl and
 * extractRoot already resolved. This module answers the only question the sweep
 * has per rollout: fire it, leave it, or write it off.
 */

/**
 * Field on `sites/{siteId}`. Mirror of `ROOST_ENABLED_FIELD` in
 * `web/lib/roostKillSwitch.ts` and `agent/src/roost_kill_switch.py` — all three
 * must stay in sync.
 */
export const ROOST_ENABLED_FIELD = 'roostEnabled';

/**
 * How late a scheduled rollout may fire before it is written off instead.
 *
 * Same principle as the talon cron's `MISSED_FIRE_GRACE_MS` (10 min at a 1-min
 * cadence): a stalled sweep must not burst on recovery — an overnight window
 * that slipped to business hours is exactly the fleet-wide surprise scheduling
 * was meant to avoid. Scaled to this sweep's 5-minute cadence, so a healthy
 * sweep has six cycles of slack before anything is written off.
 */
export const MISSED_FIRE_GRACE_MS = 30 * 60 * 1000;

/** Fallback when the rollout doc carries no extractRoot. Must match
 *  `DEFAULT_EXTRACT_ROOT` in distributionFanout.ts and the deploy route. */
export const DEFAULT_EXTRACT_ROOT = '~/Documents/Owlette';

export type ScheduledRolloutDecision =
  /** Flip to `canary` and queue the canary wave's sync_pull commands. */
  | { action: 'fire' }
  /** Leave the doc exactly as it is. */
  | { action: 'skip'; reason: 'claimed' | 'not_due' }
  /** Terminal: mark the rollout aborted so it stops blocking re-deploys. */
  | { action: 'write_off'; reason: string };

/** The fields of a `rollouts/{versionId}` doc this decision reads. */
export interface ScheduledRolloutState {
  /** `stage` as stored — anything but `'scheduled'` means someone else has it. */
  stage: unknown;
  /** `scheduledAt` in epoch ms, or null when absent/unparseable. */
  scheduledAtMs: number | null;
  /** How many canary machines the rollout was planned against. */
  canaryCount: number;
  /** Whether the rollout carries the R2 url the agents pull from. */
  hasVersionUrl: boolean;
}

/**
 * What the sweep should do with one rollout, given the doc as re-read under the
 * claim transaction.
 *
 * Write-offs exist because a rollout parked at a non-terminal stage forever also
 * blocks every future deploy of that version id — the deploy route answers
 * `alreadyRunning` until the stage is terminal.
 */
export function decideScheduledRollout(
  state: ScheduledRolloutState,
  nowMs: number,
  graceMs: number = MISSED_FIRE_GRACE_MS,
): ScheduledRolloutDecision {
  // Another sweep claimed it, or a fresh deploy overwrote the doc, between the
  // query and this read. Not an error.
  if (state.stage !== 'scheduled') return { action: 'skip', reason: 'claimed' };

  if (state.scheduledAtMs === null || !Number.isFinite(state.scheduledAtMs)) {
    // Unreachable through the due query (a doc with no `scheduledAt` is not in
    // the index), so this only catches a malformed value — which would sit at
    // `scheduled` forever otherwise.
    return { action: 'write_off', reason: 'scheduled rollout has no usable scheduledAt' };
  }

  if (state.scheduledAtMs > nowMs) return { action: 'skip', reason: 'not_due' };

  const lateMs = nowMs - state.scheduledAtMs;
  if (lateMs > graceMs) {
    return {
      action: 'write_off',
      reason:
        `missed its scheduled fire window by ${Math.round(lateMs / 60_000)}m ` +
        `(grace ${Math.round(graceMs / 60_000)}m)`,
    };
  }

  if (!state.hasVersionUrl) {
    return { action: 'write_off', reason: 'scheduled rollout has no versionUrl to fan out' };
  }

  if (state.canaryCount <= 0) {
    return { action: 'write_off', reason: 'scheduled rollout has no canary targets' };
  }

  return { action: 'fire' };
}

/**
 * Per-site roost kill switch, read from the raw `roostEnabled` field value.
 *
 * FAIL-OPEN, matching `isEnabledFromDoc` in `web/lib/roostKillSwitch.ts` and the
 * python mirror: missing, null, or non-boolean all mean ENABLED. A firestore
 * blip must never silently disable a customer's scheduled deploy.
 */
export function isRoostEnabled(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  return true;
}
