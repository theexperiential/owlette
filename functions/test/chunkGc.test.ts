/**
 * Unit tests for chunk GC (roost wave 2b.4).
 *
 * Covers the pure logic in lib/chunkGcLogic.ts and the dep-injected
 * orchestrator gcOneSite() in chunkGc.ts with in-memory fakes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  planGc,
  summarisePlan,
  TOMBSTONE_TTL_MS,
  type TombstoneRecord,
} from '../src/lib/chunkGcLogic';
import {
  gcOneSite,
  type GcDeps,
  type ObjectStore,
  type SiteScanner,
  type TombstoneStore,
} from '../src/chunkGc';

/* --------------------------------------------------------------------- */
/*  planGc                                                               */
/* --------------------------------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 10_000 * DAY_MS; // arbitrary stable "now"

describe('planGc', () => {
  it('returns an empty plan when nothing is orphaned', () => {
    const plan = planGc({
      referenced: new Set(['a', 'b', 'c']),
      stored: new Set(['a', 'b', 'c']),
      tombstones: [],
      now: NOW,
    });
    assert.deepEqual(plan.toTombstone, []);
    assert.deepEqual(plan.toDelete, []);
    assert.deepEqual(plan.tombstonesToClear, []);
  });

  it('tombstones stored-but-unreferenced chunks', () => {
    const plan = planGc({
      referenced: new Set(['a']),
      stored: new Set(['a', 'b', 'c']),
      tombstones: [],
      now: NOW,
    });
    assert.deepEqual(plan.toTombstone, ['b', 'c']);
    assert.deepEqual(plan.toDelete, []);
  });

  it('does NOT tombstone referenced-but-not-stored chunks', () => {
    // referenced but not stored = upload lag, not a GC concern.
    const plan = planGc({
      referenced: new Set(['a', 'b', 'missing']),
      stored: new Set(['a', 'b']),
      tombstones: [],
      now: NOW,
    });
    assert.deepEqual(plan.toTombstone, []);
  });

  it('deletes tombstones older than TTL', () => {
    const ripe: TombstoneRecord = {
      hash: 'old-orphan',
      tombstonedAt: NOW - TOMBSTONE_TTL_MS - 1,
    };
    const fresh: TombstoneRecord = {
      hash: 'new-orphan',
      tombstonedAt: NOW - 1 * DAY_MS,
    };
    const plan = planGc({
      referenced: new Set(['live']),
      stored: new Set(['live', 'old-orphan', 'new-orphan']),
      tombstones: [ripe, fresh],
      now: NOW,
    });
    assert.deepEqual(plan.toDelete, ['old-orphan']);
    assert.deepEqual(plan.tombstonesRetained.map((t) => t.hash), [
      'new-orphan',
    ]);
  });

  it('resurrection safety: drops tombstones for chunks that came back to life', () => {
    // regression: the whole point of a TTL is that if a chunk gets
    // re-referenced by a new manifest mid-TTL, we must NOT delete it.
    const tomb: TombstoneRecord = {
      hash: 'resurrected',
      tombstonedAt: NOW - TOMBSTONE_TTL_MS - 1, // ripe, would otherwise delete
    };
    const plan = planGc({
      referenced: new Set(['resurrected']), // came back!
      stored: new Set(['resurrected']),
      tombstones: [tomb],
      now: NOW,
    });
    assert.deepEqual(plan.toDelete, []);
    assert.deepEqual(plan.tombstonesToClear, ['resurrected']);
  });

  it('clears tombstones for chunks that vanished from storage out of band', () => {
    // operator manually deleted a chunk; tombstone lingers. GC should
    // clean it up so the tombstone collection doesn't grow forever.
    const tomb: TombstoneRecord = {
      hash: 'missing',
      tombstonedAt: NOW - 2 * DAY_MS,
    };
    const plan = planGc({
      referenced: new Set(['live']),
      stored: new Set(['live']),
      tombstones: [tomb],
      now: NOW,
    });
    assert.deepEqual(plan.toDelete, []);
    assert.deepEqual(plan.tombstonesToClear, ['missing']);
  });

  it('handles duplicate tombstone records by keeping the oldest', () => {
    // concurrent firestore writes could in theory create dupes. picking
    // the oldest tombstonedAt means TTL elapses per the earliest mark.
    const older: TombstoneRecord = { hash: 'x', tombstonedAt: NOW - 40 * DAY_MS };
    const newer: TombstoneRecord = { hash: 'x', tombstonedAt: NOW - 5 * DAY_MS };
    const plan = planGc({
      referenced: new Set(),
      stored: new Set(['x']),
      tombstones: [newer, older],
      now: NOW,
    });
    // older is ripe (>30d) so the oldest wins → delete.
    assert.deepEqual(plan.toDelete, ['x']);
  });

  it('boundary: tombstone exactly at TTL is ripe', () => {
    const tomb: TombstoneRecord = {
      hash: 'boundary',
      tombstonedAt: NOW - TOMBSTONE_TTL_MS,
    };
    const plan = planGc({
      referenced: new Set(),
      stored: new Set(['boundary']),
      tombstones: [tomb],
      now: NOW,
    });
    // uses >= TTL so exact boundary counts as ripe.
    assert.deepEqual(plan.toDelete, ['boundary']);
  });

  it('deterministic output order (sorted by hash)', () => {
    const plan = planGc({
      referenced: new Set(),
      stored: new Set(['c', 'a', 'b']),
      tombstones: [],
      now: NOW,
    });
    assert.deepEqual(plan.toTombstone, ['a', 'b', 'c']);
  });
});

describe('summarisePlan', () => {
  it('hasChanges=false on empty plan', () => {
    const s = summarisePlan({
      toTombstone: [],
      toDelete: [],
      tombstonesToClear: [],
      tombstonesRetained: [],
    });
    assert.equal(s.hasChanges, false);
  });

  it('hasChanges=true if any mutation queued', () => {
    const s = summarisePlan({
      toTombstone: ['a'],
      toDelete: [],
      tombstonesToClear: [],
      tombstonesRetained: [],
    });
    assert.equal(s.hasChanges, true);
    assert.equal(s.newTombstones, 1);
  });
});

/* --------------------------------------------------------------------- */
/*  gcOneSite orchestrator                                               */
/* --------------------------------------------------------------------- */

interface FakeState {
  referenced: Set<string>;
  stored: Set<string>;
  tombstones: TombstoneRecord[];
  activeRollout: boolean;
  deletedChunks: string[];
  createdTombstones: string[];
  clearedTombstones: string[];
}

function makeFakes(state: FakeState): {
  scanner: SiteScanner;
  store: ObjectStore;
  tombstones: TombstoneStore;
} {
  return {
    scanner: {
      async listSiteIds() { return ['site-1']; },
      async getReferencedHashes() { return state.referenced; },
      async hasActiveRollout() { return state.activeRollout; },
    },
    store: {
      async listStoredHashes() { return state.stored; },
      async deleteChunk(_siteId, hash) {
        state.deletedChunks.push(hash);
        state.stored.delete(hash);
      },
    },
    tombstones: {
      async list() { return state.tombstones; },
      async create(_siteId, hashes, now) {
        for (const h of hashes) {
          state.createdTombstones.push(h);
          state.tombstones.push({ hash: h, tombstonedAt: now.getTime() });
        }
      },
      async clear(_siteId, hashes) {
        for (const h of hashes) state.clearedTombstones.push(h);
        state.tombstones = state.tombstones.filter(
          (t) => !hashes.includes(t.hash),
        );
      },
    },
  };
}

function makeDeps(state: FakeState, mode: 'dry-run' | 'apply' = 'apply'): GcDeps {
  const { scanner, store, tombstones } = makeFakes(state);
  return {
    scanner,
    store,
    tombstones,
    mode,
    now: () => new Date(NOW),
  };
}

describe('gcOneSite', () => {
  it('skips a site with an active rollout', async () => {
    const state: FakeState = {
      referenced: new Set(['a']),
      stored: new Set(['a', 'orphan']),
      tombstones: [],
      activeRollout: true,
      deletedChunks: [],
      createdTombstones: [],
      clearedTombstones: [],
    };
    const r = await gcOneSite('site-1', makeDeps(state));
    assert.equal(r.skipped, true);
    assert.equal(r.skipReason, 'active_rollout');
    // nothing mutated during the skip.
    assert.equal(state.deletedChunks.length, 0);
    assert.equal(state.createdTombstones.length, 0);
  });

  it('tombstones orphans on first run', async () => {
    const state: FakeState = {
      referenced: new Set(['live']),
      stored: new Set(['live', 'orphan-1', 'orphan-2']),
      tombstones: [],
      activeRollout: false,
      deletedChunks: [],
      createdTombstones: [],
      clearedTombstones: [],
    };
    const r = await gcOneSite('site-1', makeDeps(state));
    assert.equal(r.skipped, false);
    assert.deepEqual(state.createdTombstones.sort(), ['orphan-1', 'orphan-2']);
    assert.equal(state.deletedChunks.length, 0);
  });

  it('deletes ripe tombstoned chunks and clears their tombstones', async () => {
    const state: FakeState = {
      referenced: new Set(['live']),
      stored: new Set(['live', 'ripe']),
      tombstones: [{ hash: 'ripe', tombstonedAt: NOW - TOMBSTONE_TTL_MS - 1 }],
      activeRollout: false,
      deletedChunks: [],
      createdTombstones: [],
      clearedTombstones: [],
    };
    const r = await gcOneSite('site-1', makeDeps(state));
    assert.equal(r.skipped, false);
    assert.deepEqual(state.deletedChunks, ['ripe']);
    assert.deepEqual(state.clearedTombstones, ['ripe']);
  });

  it('dry-run mode: logs but does not mutate', async () => {
    const state: FakeState = {
      referenced: new Set(['live']),
      stored: new Set(['live', 'ripe']),
      tombstones: [{ hash: 'ripe', tombstonedAt: NOW - TOMBSTONE_TTL_MS - 1 }],
      activeRollout: false,
      deletedChunks: [],
      createdTombstones: [],
      clearedTombstones: [],
    };
    const r = await gcOneSite('site-1', makeDeps(state, 'dry-run'));
    assert.equal(r.skipped, false);
    assert.equal(r.mode, 'dry-run');
    assert.equal(state.deletedChunks.length, 0);
    assert.equal(state.createdTombstones.length, 0);
    assert.equal(state.clearedTombstones.length, 0);
    assert.equal(r.summary!.deletions, 1);
  });

  it('apply mode no-op when nothing changed', async () => {
    const state: FakeState = {
      referenced: new Set(['a', 'b']),
      stored: new Set(['a', 'b']),
      tombstones: [],
      activeRollout: false,
      deletedChunks: [],
      createdTombstones: [],
      clearedTombstones: [],
    };
    const r = await gcOneSite('site-1', makeDeps(state));
    assert.equal(r.summary!.hasChanges, false);
    assert.equal(state.deletedChunks.length, 0);
  });

  it('resurrection guard also flows through the orchestrator', async () => {
    const state: FakeState = {
      referenced: new Set(['resurrected']),
      stored: new Set(['resurrected']),
      tombstones: [
        { hash: 'resurrected', tombstonedAt: NOW - TOMBSTONE_TTL_MS - 1 },
      ],
      activeRollout: false,
      deletedChunks: [],
      createdTombstones: [],
      clearedTombstones: [],
    };
    await gcOneSite('site-1', makeDeps(state));
    assert.deepEqual(state.deletedChunks, []);
    assert.deepEqual(state.clearedTombstones, ['resurrected']);
  });
});
