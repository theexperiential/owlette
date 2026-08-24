/**
 * Unit tests for lib/fanoutLogic.ts — pure decision logic only; the
 * firestore-backed handlers in distributionFanout.ts need the emulator.
 * Node's built-in runner (node:test): `npm test` in functions/ after
 * `npm run build`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANARY_ABORT_FAILURE_RATE,
  CANARY_SUCCESS_THRESHOLD,
  canarySizeFor,
  canaryShouldAbort,
  canaryShouldPromote,
  evaluateWave,
  nextStage,
  selectCanary,
  type TargetState,
} from '../src/lib/fanoutLogic';

describe('canarySizeFor', () => {
  it('returns 0 for an empty fleet', () => {
    assert.equal(canarySizeFor(0), 0);
  });

  it('returns 1 (minimum) for a fleet of 1', () => {
    assert.equal(canarySizeFor(1), 1);
  });

  it('returns 1 for a fleet of 5 (10% rounds up, floor is 1)', () => {
    assert.equal(canarySizeFor(5), 1);
  });

  it('returns 1 for a fleet of 10', () => {
    assert.equal(canarySizeFor(10), 1);
  });

  it('returns 2 for a fleet of 11', () => {
    assert.equal(canarySizeFor(11), 2);
  });

  it('returns 10 for a fleet of 100', () => {
    assert.equal(canarySizeFor(100), 10);
  });

  it('caps at 50 for huge fleets (10k machines)', () => {
    assert.equal(canarySizeFor(10_000), 50);
  });

  it('never exceeds fleet size (edge: tiny fleet)', () => {
    assert.ok(canarySizeFor(3) <= 3);
  });
});

describe('selectCanary', () => {
  it('returns empty cohorts for an empty fleet', () => {
    const r = selectCanary([], 'version-a');
    assert.deepEqual(r, { canary: [], fleet: [] });
  });

  it('sums to the input size', () => {
    const ids = Array.from({ length: 37 }, (_, i) => `machine-${i}`);
    const r = selectCanary(ids, 'm');
    assert.equal(r.canary.length + r.fleet.length, ids.length);
  });

  it('picks the expected canary size for the fleet', () => {
    const ids = Array.from({ length: 100 }, (_, i) => `m${i}`);
    const r = selectCanary(ids, 'version-x');
    assert.equal(r.canary.length, canarySizeFor(100));
  });

  it('is deterministic across calls with the same inputs', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'];
    const r1 = selectCanary(ids, 'version-1');
    const r2 = selectCanary(ids, 'version-1');
    assert.deepEqual(r1.canary, r2.canary);
    assert.deepEqual(r1.fleet, r2.fleet);
  });

  it('produces different cohorts for different versions', () => {
    // 100 machines / canary 10: two hashes colliding on the same cohort is negligible.
    const ids = Array.from({ length: 100 }, (_, i) => `m${i}`);
    const a = selectCanary(ids, 'version-a').canary;
    const b = selectCanary(ids, 'version-b').canary;
    assert.notDeepEqual(a, b);
  });

  it('is stable to input-order shuffling', () => {
    // Membership is hash-stable regardless of input order; output order follows
    // input order for UI predictability.
    const forward = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'];
    const reversed = [...forward].reverse();
    const a = new Set(selectCanary(forward, 'm').canary);
    const b = new Set(selectCanary(reversed, 'm').canary);
    assert.deepEqual([...a].sort(), [...b].sort());
  });

  it('every machine lands in exactly one cohort (no overlap, no loss)', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `m${i}`);
    const r = selectCanary(ids, 'm');
    const overlap = r.canary.filter((id) => r.fleet.includes(id));
    assert.equal(overlap.length, 0);
    const all = new Set([...r.canary, ...r.fleet]);
    assert.equal(all.size, ids.length);
  });
});

function wave(template: Record<string, number>): TargetState[] {
  // `{ succeeded: 3, failed: 1, pending: 2 }` → 6 target states
  const out: TargetState[] = [];
  for (const [status, count] of Object.entries(template)) {
    for (let i = 0; i < count; i++) {
      out.push({ machineId: `m-${status}-${i}`, status: status as any });
    }
  }
  return out;
}

describe('evaluateWave', () => {
  it('reports a fresh wave as in-flight', () => {
    const e = evaluateWave(wave({ pending: 5 }));
    assert.equal(e.total, 5);
    assert.equal(e.settled, false);
    assert.equal(e.succeeded, 0);
    assert.equal(e.failed, 0);
  });

  it('reports a fully-succeeded wave as settled', () => {
    const e = evaluateWave(wave({ succeeded: 4 }));
    assert.equal(e.settled, true);
    assert.equal(e.successRate, 1);
    assert.equal(e.failureRate, 0);
  });

  it('treats `cancelled` as failure (in-flight cancellations count)', () => {
    const e = evaluateWave(wave({ succeeded: 3, cancelled: 1 }));
    assert.equal(e.failed, 1);
    assert.equal(e.failureRate, 0.25);
  });

  it('does not count in_progress as pending-without-report', () => {
    // in_progress is still pending — not a terminal state.
    const e = evaluateWave(wave({ in_progress: 2, succeeded: 1 } as any));
    assert.equal(e.pending, 2);
    assert.equal(e.settled, false);
  });

  it('empty wave settles vacuously (nothing left in flight), failureRate=0', () => {
    // Regression (spike 2026-08-13): settled=false parked every 1-machine
    // rollout at stage "fleet" — its fleet wave is empty and never completed.
    const e = evaluateWave([]);
    assert.equal(e.total, 0);
    assert.equal(e.pending, 0);
    assert.equal(e.settled, true);
    assert.equal(e.failureRate, 0);
  });
});

describe('canaryShouldAbort', () => {
  it('does not abort when failure rate is within threshold', () => {
    // 1 out of 10 failed is 10%, under the 25% threshold.
    const e = evaluateWave(wave({ failed: 1, pending: 9 }));
    assert.equal(canaryShouldAbort(e), false);
  });

  it('aborts immediately when failure rate already exceeds threshold', () => {
    // 3/10 = 30%, above 25%.
    const e = evaluateWave(wave({ failed: 3, pending: 7 }));
    assert.equal(canaryShouldAbort(e), true);
  });

  it('does NOT require settlement — aborts mid-wave', () => {
    // Regression: abort early, don't wait for the rest of the canary to fail.
    const e = evaluateWave(wave({ failed: 4, pending: 6 }));
    assert.equal(e.settled, false);
    assert.equal(canaryShouldAbort(e), true);
  });

  it('does not abort empty wave', () => {
    assert.equal(canaryShouldAbort(evaluateWave([])), false);
  });

  it('boundary: exactly at abort threshold does not abort', () => {
    // using > not >= in the gate — consistent with "strictly worse than tolerated"
    const e = evaluateWave(wave({ failed: 1, succeeded: 3 }));
    assert.equal(e.failureRate, CANARY_ABORT_FAILURE_RATE); // 0.25
    assert.equal(canaryShouldAbort(e), false);
  });
});

describe('canaryShouldPromote', () => {
  it('does not promote while targets are still pending', () => {
    const e = evaluateWave(wave({ succeeded: 9, pending: 1 }));
    assert.equal(canaryShouldPromote(e), false);
  });

  it('promotes on 100% success', () => {
    const e = evaluateWave(wave({ succeeded: 10 }));
    assert.equal(canaryShouldPromote(e), true);
  });

  it('promotes at success threshold (90%)', () => {
    const e = evaluateWave(wave({ succeeded: 9, failed: 1 }));
    assert.equal(e.successRate, CANARY_SUCCESS_THRESHOLD);
    assert.equal(canaryShouldPromote(e), true);
  });

  it('does not promote below success threshold', () => {
    // 8/10 = 80%, below the 90% bar
    const e = evaluateWave(wave({ succeeded: 8, failed: 2 }));
    assert.equal(canaryShouldPromote(e), false);
  });

  it('does not promote empty wave', () => {
    assert.equal(canaryShouldPromote(evaluateWave([])), false);
  });
});

describe('nextStage', () => {
  it('canary in flight → null (no transition yet)', () => {
    const e = evaluateWave(wave({ succeeded: 5, pending: 5 }));
    assert.equal(nextStage('canary', e), null);
  });

  it('canary succeeded → promote to fleet', () => {
    const e = evaluateWave(wave({ succeeded: 10 }));
    const t = nextStage('canary', e);
    assert.ok(t);
    assert.equal(t!.stage, 'fleet');
    assert.match(t!.reason, /canary passed/);
  });

  it('canary with excessive failures → abort', () => {
    const e = evaluateWave(wave({ failed: 4, succeeded: 6 }));
    const t = nextStage('canary', e);
    assert.ok(t);
    assert.equal(t!.stage, 'aborted');
  });

  it('abort takes precedence over promote', () => {
    // Contrived (can't coexist in real data), but the priority ordering matters
    // for other edge cases such as a fleet wave aborting.
    const e = evaluateWave(wave({ succeeded: 10, failed: 4 }));
    const t = nextStage('canary', e);
    assert.ok(t);
    assert.equal(t!.stage, 'aborted');
  });

  it('fleet wave settles → complete', () => {
    const e = evaluateWave(wave({ succeeded: 20 }));
    const t = nextStage('fleet', e);
    assert.ok(t);
    assert.equal(t!.stage, 'complete');
  });

  it('fleet wave in flight → null', () => {
    const e = evaluateWave(wave({ succeeded: 15, pending: 5 }));
    assert.equal(nextStage('fleet', e), null);
  });

  it('fleet wave aborts on excessive failures', () => {
    const e = evaluateWave(wave({ failed: 10, succeeded: 10 }));
    const t = nextStage('fleet', e);
    assert.ok(t);
    assert.equal(t!.stage, 'aborted');
  });

  it('terminal stages never transition', () => {
    const e = evaluateWave(wave({ succeeded: 10 }));
    assert.equal(nextStage('complete', e), null);
    assert.equal(nextStage('aborted', e), null);
  });

  it('empty fleet wave → complete (nothing to wait for)', () => {
    const t = nextStage('fleet', evaluateWave([]));
    assert.ok(t);
    assert.equal(t!.stage, 'complete');
  });

  it('empty canary wave → no transition (never promotes on nothing)', () => {
    // An empty canary means selectCanary had no machines, not a passing wave.
    assert.equal(nextStage('canary', evaluateWave([])), null);
  });
});

describe('single-machine rollout', () => {
  const VERSION = 'vrs_single_machine';

  it('puts the only machine in the canary and leaves the fleet wave empty', () => {
    const r = selectCanary(['machine-solo'], VERSION);
    assert.deepEqual(r.canary, ['machine-solo']);
    assert.deepEqual(r.fleet, []);
  });

  it('happy path: canary succeeds → fleet promotion → complete', () => {
    const { canary, fleet } = selectCanary(['machine-solo'], VERSION);

    // 1. the agent reports `committed`, which coerces to `succeeded`.
    const canaryEval = evaluateWave(
      canary.map((machineId) => ({ machineId, status: 'succeeded' as const })),
    );
    assert.equal(canaryEval.settled, true);
    const promote = nextStage('canary', canaryEval);
    assert.ok(promote);
    assert.equal(promote!.stage, 'fleet');

    // 2. the empty fleet wave settles immediately — the transition
    // distributionFanout.ts cascades to in the same transaction. It used to
    // return null, stranding the rollout at stage "fleet".
    const fleetEval = evaluateWave(
      fleet.map((machineId) => ({ machineId, status: 'pending' as const })),
    );
    const finish = nextStage('fleet', fleetEval);
    assert.ok(finish);
    assert.equal(finish!.stage, 'complete');
  });

  it('failure path: the only machine fails → aborted, never promoted', () => {
    const { canary } = selectCanary(['machine-solo'], VERSION);
    const canaryEval = evaluateWave(
      canary.map((machineId) => ({ machineId, status: 'failed' as const })),
    );

    // 1/1 = 100% failure, far past the 25% abort gate.
    assert.equal(canaryEval.failureRate, 1);
    assert.equal(canaryShouldAbort(canaryEval), true);
    assert.equal(canaryShouldPromote(canaryEval), false);

    const t = nextStage('canary', canaryEval);
    assert.ok(t);
    assert.equal(t!.stage, 'aborted');
    assert.match(t!.reason, /1\/1 targets failed/);
  });

  it('failure path: a cancelled sync aborts the same way as a failure', () => {
    const canaryEval = evaluateWave([
      { machineId: 'machine-solo', status: 'cancelled' },
    ]);
    const t = nextStage('canary', canaryEval);
    assert.ok(t);
    assert.equal(t!.stage, 'aborted');
  });

  it('stays in flight while the only machine is still downloading', () => {
    const canaryEval = evaluateWave([
      { machineId: 'machine-solo', status: 'in_progress' },
    ]);
    assert.equal(canaryEval.settled, false);
    assert.equal(nextStage('canary', canaryEval), null);
  });
});
