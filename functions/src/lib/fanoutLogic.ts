/**
 * Pure logic for roost distribution fan-out — split from the firestore trigger so the canary
 * decisions are unit-testable without an emulator.
 *
 * Staged rollout, never all-at-once: a bad config pushed to 100% of a fleet is a fleet-wide
 * outage (cloudflare, 2025-11-18).
 */

/** Canary is 10% of the fleet, rounded up, with a floor of 1 machine. */
export const CANARY_FRACTION = 0.1;

/** Minimum canary size; a fleet of 3 still gets 1 canary. */
export const CANARY_MIN = 1;

/** Cap so a 10k fleet doesn't canary 1k machines — that IS the blast radius we're avoiding. */
export const CANARY_MAX = 50;

/** Proceed at ≥90% canary success — single flakes shouldn't abort a fleet-wide rollout. */
export const CANARY_SUCCESS_THRESHOLD = 0.9;

/** >25% canary failure = something structurally wrong (bad version, missing chunks); abort. */
export const CANARY_ABORT_FAILURE_RATE = 0.25;

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
  total: number;
  succeeded: number;
  failed: number;
  /** still pending or in_progress */
  pending: number;
  /** Nothing in flight. An empty wave is vacuously settled — see {@link evaluateWave}. */
  settled: boolean;
  /** 0..1 among settled targets, NaN if nothing settled */
  successRate: number;
  /** 0..1 among ALL targets, not just settled — the abort gate reads this */
  failureRate: number;
}

/**
 * Pick the canary cohort by stable hash of `machineId + versionId`, so trigger retries don't flap
 * the cohort mid-rollout. Sorted before slicing, so firestore iteration order can't change it.
 */
export function selectCanary(
  machineIds: readonly string[],
  versionId: string,
): { canary: string[]; fleet: string[] } {
  if (machineIds.length === 0) {
    return { canary: [], fleet: [] };
  }

  const canarySize = canarySizeFor(machineIds.length);

  // Score each machine, take the N lowest; ties break on machineId lexicographic order.
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
  // Fleet smaller than CANARY_MIN: everyone is the canary and the fleet wave is empty. Clamp to
  // fleetSize so we never canary more machines than exist.
  return Math.min(bounded, fleetSize);
}

/**
 * Summarise a rollout wave: are we done, and how did it go?
 *
 * An empty wave settles vacuously. Required for the single-machine case — `canarySizeFor(1) === 1`
 * so the fleet wave is empty, and treating it as unsettled parked every 1-machine rollout at
 * `stage: "fleet"` forever. The abort and promote gates keep their own `total > 0` guards, so only
 * `fleet → complete` reads `settled` as done.
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
  const settled = pending === 0;
  const successRate = terminal === 0 ? NaN : succeeded / terminal;
  const failureRate = total === 0 ? 0 : failed / total;

  return { total, succeeded, failed, pending, settled, successRate, failureRate };
}

/** Should the canary abort the fleet rollout? */
export function canaryShouldAbort(eval_: RolloutEvaluation): boolean {
  // Does NOT wait for settlement: failureRate measures against `total`, so 30% failed at 50%
  // settlement already locks in >25% no matter how the rest land. Bail immediately.
  return eval_.total > 0 && eval_.failureRate > CANARY_ABORT_FAILURE_RATE;
}

/** Should the canary pass and fleet wave start? */
export function canaryShouldPromote(eval_: RolloutEvaluation): boolean {
  if (!eval_.settled) return false;
  if (eval_.total === 0) return false;
  return eval_.successRate >= CANARY_SUCCESS_THRESHOLD;
}

/** Next stage from the current stage + evaluation, with a human-readable reason. */
export function nextStage(
  currentStage: RolloutStage,
  eval_: RolloutEvaluation,
): { stage: RolloutStage; reason: string } | null {
  if (currentStage === 'complete' || currentStage === 'aborted') {
    return null; // terminal
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

/** FNV-1a 32-bit. Canary selection needs stable + uniform, not cryptographic strength. */
function stableHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0; // unsigned 32-bit
}
