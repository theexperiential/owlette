/**
 * Pure logic for roost distribution fan-out (wave 2b.3).
 *
 * Split out from the firestore-trigger handler so the interesting
 * decisions (who is in the canary? did canary pass? did it fail hard
 * enough to abort?) can be unit-tested without firestore-emulator setup.
 *
 * Design principle: staged rollout, never all-at-once. The cloudflare
 * 2025-11-18 incident is a standing reminder — a bad config pushed to
 * 100% of a fleet is a fleet-wide outage.
 */

/* --------------------------------------------------------------------- */
/*  Tuning constants                                                     */
/* --------------------------------------------------------------------- */

/** Canary is 10% of the fleet, rounded up, with a floor of 1 machine. */
export const CANARY_FRACTION = 0.1;

/** Minimum canary size; a fleet of 3 still gets 1 canary. */
export const CANARY_MIN = 1;

/**
 * Cap on canary size so a 10k-machine fleet doesn't ship 1k machines
 * as the canary (that IS the blast radius we want to avoid).
 */
export const CANARY_MAX = 50;

/**
 * Canary pass threshold. If ≥90% of canary reported success, proceed.
 * Any failure at all is a signal to investigate, but single flakes
 * shouldn't abort a fleet-wide rollout.
 */
export const CANARY_SUCCESS_THRESHOLD = 0.9;

/**
 * Canary abort threshold. If >25% of canary failed, abort rollout —
 * something is structurally wrong (bad version, missing chunks, etc.).
 */
export const CANARY_ABORT_FAILURE_RATE = 0.25;

/* --------------------------------------------------------------------- */
/*  Types                                                                */
/* --------------------------------------------------------------------- */

export type RolloutStage = 'canary' | 'fleet' | 'complete' | 'aborted';

export type TargetStatus =
  | 'pending'
  | 'in_progress'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface TargetState {
  machineId: string;
  status: TargetStatus;
}

export interface RolloutEvaluation {
  /** total in this wave */
  total: number;
  /** targets currently reporting succeeded */
  succeeded: number;
  /** targets currently reporting failed */
  failed: number;
  /** targets still pending/in_progress */
  pending: number;
  /** all wave targets are in a terminal state */
  settled: boolean;
  /** success rate among settled targets (0..1, NaN if nothing settled) */
  successRate: number;
  /** failure rate among all targets (not just settled) — used for abort gate */
  failureRate: number;
}

/* --------------------------------------------------------------------- */
/*  Canary selection                                                     */
/* --------------------------------------------------------------------- */

/**
 * Deterministically pick the canary cohort for a rollout.
 *
 * Selection is a stable hash of `machineId + versionId`. The same
 * machine wakes up in the canary for the same version deterministically,
 * so re-runs of the trigger (e.g. retries) don't flap between canary
 * cohorts mid-rollout.
 *
 * Inputs are sorted before slicing so the output is stable regardless
 * of firestore iteration order.
 */
export function selectCanary(
  machineIds: readonly string[],
  versionId: string,
): { canary: string[]; fleet: string[] } {
  if (machineIds.length === 0) {
    return { canary: [], fleet: [] };
  }

  const canarySize = canarySizeFor(machineIds.length);

  // stable-score each machine, then slice off the N lowest scores.
  // using a commutative hash (`+`) of machineId and versionId gives us
  // the same score regardless of which side is hashed first, and ties
  // are broken by machineId lexicographic order.
  const scored = machineIds.map((id) => ({
    id,
    score: stableHash(`${id}::${versionId}`),
  }));

  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const canarySet = new Set(scored.slice(0, canarySize).map((s) => s.id));
  const canary: string[] = [];
  const fleet: string[] = [];

  for (const id of machineIds) {
    if (canarySet.has(id)) canary.push(id);
    else fleet.push(id);
  }

  return { canary, fleet };
}

/** Canary size for a fleet of N machines. */
export function canarySizeFor(fleetSize: number): number {
  if (fleetSize <= 0) return 0;
  const ceiling = Math.ceil(fleetSize * CANARY_FRACTION);
  const bounded = Math.max(CANARY_MIN, Math.min(CANARY_MAX, ceiling));
  // edge case: fleet is smaller than the minimum canary — every machine
  // is the canary and the fleet wave is empty. we still return the
  // fleet size (not CANARY_MIN) so we never try to canary more machines
  // than exist.
  return Math.min(bounded, fleetSize);
}

/* --------------------------------------------------------------------- */
/*  Rollout stage evaluation                                             */
/* --------------------------------------------------------------------- */

/**
 * Summarise the state of a rollout wave. Callers feed the current
 * reported target statuses; this function returns the pure computation
 * of "are we done, and how did it go?"
 */
export function evaluateWave(targets: readonly TargetState[]): RolloutEvaluation {
  const total = targets.length;
  let succeeded = 0;
  let failed = 0;

  for (const t of targets) {
    if (t.status === 'succeeded') succeeded++;
    else if (t.status === 'failed' || t.status === 'cancelled') failed++;
  }

  const terminal = succeeded + failed;
  const pending = total - terminal;
  const settled = total > 0 && pending === 0;
  const successRate = terminal === 0 ? NaN : succeeded / terminal;
  const failureRate = total === 0 ? 0 : failed / total;

  return { total, succeeded, failed, pending, settled, successRate, failureRate };
}

/** Should the canary abort the fleet rollout? */
export function canaryShouldAbort(eval_: RolloutEvaluation): boolean {
  // abort decision does NOT wait for settlement: if enough canary members
  // have ALREADY failed that even a perfect outcome for the rest couldn't
  // satisfy the abort gate, we should bail immediately. this is what the
  // `failureRate > CANARY_ABORT_FAILURE_RATE` check computes — it measures
  // failures against `total`, so a 30% failure rate at 50% settlement
  // already locks in >25% failure regardless of the remaining targets.
  return eval_.total > 0 && eval_.failureRate > CANARY_ABORT_FAILURE_RATE;
}

/** Should the canary pass and fleet wave start? */
export function canaryShouldPromote(eval_: RolloutEvaluation): boolean {
  if (!eval_.settled) return false;
  if (eval_.total === 0) return false;
  return eval_.successRate >= CANARY_SUCCESS_THRESHOLD;
}

/**
 * Decide the next stage given the current stage + evaluation.
 * Returns the stage transition + a human-readable reason.
 */
export function nextStage(
  currentStage: RolloutStage,
  eval_: RolloutEvaluation,
): { stage: RolloutStage; reason: string } | null {
  if (currentStage === 'complete' || currentStage === 'aborted') {
    return null; // terminal — no further transitions
  }

  if (canaryShouldAbort(eval_)) {
    return {
      stage: 'aborted',
      reason:
        `${eval_.failed}/${eval_.total} targets failed ` +
        `(${(eval_.failureRate * 100).toFixed(1)}% > ` +
        `${(CANARY_ABORT_FAILURE_RATE * 100).toFixed(0)}% threshold)`,
    };
  }

  if (currentStage === 'canary' && canaryShouldPromote(eval_)) {
    return {
      stage: 'fleet',
      reason: `canary passed (${eval_.succeeded}/${eval_.total})`,
    };
  }

  if (currentStage === 'fleet' && eval_.settled) {
    return {
      stage: 'complete',
      reason: `fleet settled (${eval_.succeeded} succeeded, ${eval_.failed} failed)`,
    };
  }

  return null; // no transition — still in flight
}

/* --------------------------------------------------------------------- */
/*  Stable hash (FNV-1a 32-bit)                                          */
/* --------------------------------------------------------------------- */

/**
 * FNV-1a 32-bit — deterministic, well-distributed for short strings,
 * no crypto overhead. Canary selection doesn't need cryptographic
 * strength; it needs stable + uniform.
 */
function stableHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // force unsigned 32-bit
  return hash >>> 0;
}
