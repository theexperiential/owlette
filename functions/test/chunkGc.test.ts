/**
 * Unit tests for chunk GC (roost wave 2b.4).
 *
 * Covers the pure logic in lib/chunkGcLogic.ts and the dep-injected
 * orchestrator gcOneSite() in chunkGc.ts with in-memory fakes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractChunkHashes,
  planGc,
  summarisePlan,
  TOMBSTONE_TTL_MS,
  type TombstoneRecord,
} from '../src/lib/chunkGcLogic';
import {
  createFirestoreScanner,
  createR2ObjectStore,
  gcAllSites,
  gcOneSite,
  resolveMode,
  type GcDeps,
  type GcMode,
  type ObjectStore,
  type SiteScanner,
  type TombstoneStore,
} from '../src/chunkGc';
import { chunkKey, versionKey, type R2Client } from '../src/lib/r2Client';

// planGc

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
    // Regression: a chunk re-referenced by a new version mid-TTL must NOT be deleted.
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
    // Operator deleted a chunk manually; GC must clear the lingering tombstone.
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
    // Concurrent firestore writes can create dupes; oldest tombstonedAt wins so
    // the TTL elapses from the earliest mark.
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

// gcOneSite orchestrator

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

  it('a failed scan mutates nothing, even in apply mode', async () => {
    const state: FakeState = {
      referenced: new Set(),
      stored: new Set(['ripe']),
      tombstones: [{ hash: 'ripe', tombstonedAt: NOW - TOMBSTONE_TTL_MS - 1 }],
      activeRollout: false,
      deletedChunks: [],
      createdTombstones: [],
      clearedTombstones: [],
    };
    const deps = makeDeps(state);
    deps.scanner = {
      ...deps.scanner,
      async getReferencedHashes() {
        throw new Error('version body unreadable');
      },
    };
    const r = await gcOneSite('site-1', deps);
    assert.equal(r.skipped, true);
    assert.match(r.skipReason!, /scan_error/);
    assert.deepEqual(state.deletedChunks, []);
    assert.deepEqual(state.createdTombstones, []);
    assert.deepEqual(state.clearedTombstones, []);
  });
});

// mode flag

describe('resolveMode', () => {
  it('defaults to dry-run when the flag is absent or empty', () => {
    assert.equal(resolveMode({}), 'dry-run');
    assert.equal(resolveMode({ CHUNK_GC_MODE: '' }), 'dry-run');
  });

  it('only the exact string "apply" enables deletion', () => {
    assert.equal(resolveMode({ CHUNK_GC_MODE: 'apply' }), 'apply');
    assert.equal(resolveMode({ CHUNK_GC_MODE: '  apply  ' }), 'apply');
    assert.equal(resolveMode({ CHUNK_GC_MODE: 'APPLY' }), 'dry-run');
    assert.equal(resolveMode({ CHUNK_GC_MODE: 'true' }), 'dry-run');
    assert.equal(resolveMode({ CHUNK_GC_MODE: 'apply-please' }), 'dry-run');
  });
});

// extractChunkHashes — the reference-truth parser

/** 64-char lowercase hex, stable per seed. */
function hex(seed: number): string {
  return seed.toString(16).padStart(64, '0');
}

function versionBody(hashes: string[]): string {
  return JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.owlette.version.v1+json',
    config: {},
    files: [
      {
        path: 'show.tox',
        size: hashes.length,
        chunks: hashes.map((hash) => ({ hash, size: 1 })),
      },
    ],
  });
}

describe('extractChunkHashes', () => {
  it('reads every hash across every file', () => {
    const body = {
      schemaVersion: 2,
      files: [
        { path: 'a', chunks: [{ hash: hex(1) }, { hash: hex(2) }] },
        { path: 'b', chunks: [{ hash: hex(2) }, { hash: hex(3) }] },
      ],
    };
    assert.deepEqual(extractChunkHashes(body), [hex(1), hex(2), hex(2), hex(3)]);
  });

  it('accepts a version with no files (contributes no references)', () => {
    assert.deepEqual(extractChunkHashes({ schemaVersion: 2, files: [] }), []);
  });

  it('throws on every malformed shape rather than under-reporting', () => {
    const cases: unknown[] = [
      null,
      'a string',
      [],
      {},
      { schemaVersion: 1, files: [] },
      { schemaVersion: '2', files: [] },
      { schemaVersion: 2 },
      { schemaVersion: 2, files: {} },
      { schemaVersion: 2, files: [null] },
      { schemaVersion: 2, files: [{ path: 'a' }] },
      { schemaVersion: 2, files: [{ chunks: [null] }] },
      { schemaVersion: 2, files: [{ chunks: [{}] }] },
      { schemaVersion: 2, files: [{ chunks: [{ hash: 'short' }] }] },
      { schemaVersion: 2, files: [{ chunks: [{ hash: 'A'.repeat(64) }] }] },
    ];
    for (const body of cases) {
      assert.throws(
        () => extractChunkHashes(body),
        `expected a throw for ${JSON.stringify(body)}`,
      );
    }
  });
});

// production wiring: firestore scanner + R2 object store

const MANIFEST_BUCKET = 'owlette-dev-manifests';
const CONTENT_BUCKET = 'owlette-dev-content';

interface FakeRoost {
  versions: string[];
  activeRollout?: boolean;
}

interface FakeQuery {
  where(): FakeQuery;
  limit(): FakeQuery;
  get(): Promise<{ empty: boolean }>;
}

/** Just enough firestore for the scanner: listDocuments + the rollout query. */
function makeFakeDb(
  sites: Record<string, Record<string, FakeRoost>>,
  opts: { failSiteListing?: boolean } = {},
): FirebaseFirestore.Firestore {
  const query = (empty: boolean): FakeQuery => {
    const q: FakeQuery = {
      where: () => q,
      limit: () => q,
      get: async () => ({ empty }),
    };
    return q;
  };

  const roostRef = (siteId: string, roostId: string) => ({
    id: roostId,
    collection(name: string) {
      const roost = sites[siteId][roostId];
      if (name === 'versions') {
        return {
          async listDocuments() {
            return roost.versions.map((id) => ({ id }));
          },
        };
      }
      if (name === 'rollouts') return query(!roost.activeRollout);
      throw new Error(`unexpected roost subcollection: ${name}`);
    },
  });

  return {
    collection(name: string) {
      if (name !== 'sites') throw new Error(`unexpected root collection: ${name}`);
      return {
        async listDocuments() {
          if (opts.failSiteListing) throw new Error('firestore unavailable');
          return Object.keys(sites).map((id) => ({ id }));
        },
        doc(siteId: string) {
          return {
            collection(sub: string) {
              if (sub !== 'roosts') {
                throw new Error(`unexpected site subcollection: ${sub}`);
              }
              return {
                async listDocuments() {
                  return Object.keys(sites[siteId] ?? {}).map((rid) =>
                    roostRef(siteId, rid),
                  );
                },
              };
            },
          };
        },
      };
    },
  } as unknown as FirebaseFirestore.Firestore;
}

interface FakeR2 {
  client: R2Client;
  objects: Record<string, string>;
  deleted: string[];
  fail: Set<string>;
}

/** Keys are `${bucket}/${key}`. `fail` holds `list:<bucket>/<prefix>` markers. */
function makeFakeR2(objects: Record<string, string>): FakeR2 {
  const deleted: string[] = [];
  const fail = new Set<string>();
  const client: R2Client = {
    async listKeys(bucket, prefix) {
      if (fail.has(`list:${bucket}/${prefix}`)) throw new Error('r2 list failed');
      const full = `${bucket}/${prefix}`;
      return Object.keys(objects)
        .filter((k) => k.startsWith(full))
        .map((k) => k.slice(bucket.length + 1));
    },
    async getText(bucket, key) {
      const full = `${bucket}/${key}`;
      if (fail.has(`get:${full}`)) throw new Error('r2 get failed');
      return Object.prototype.hasOwnProperty.call(objects, full)
        ? objects[full]
        : null;
    },
    async deleteObject(bucket, key) {
      const full = `${bucket}/${key}`;
      deleted.push(full);
      delete objects[full];
    },
  };
  return { client, objects, deleted, fail };
}

function memoryTombstones(
  seed: Record<string, TombstoneRecord[]> = {},
): TombstoneStore & { created: string[]; cleared: string[] } {
  const state: Record<string, TombstoneRecord[]> = { ...seed };
  const created: string[] = [];
  const cleared: string[] = [];
  return {
    created,
    cleared,
    async list(siteId) {
      return state[siteId] ?? [];
    },
    async create(siteId, hashes, now) {
      state[siteId] = [
        ...(state[siteId] ?? []),
        ...hashes.map((hash) => ({ hash, tombstonedAt: now.getTime() })),
      ];
      created.push(...hashes.map((h) => `${siteId}/${h}`));
    },
    async clear(siteId, hashes) {
      state[siteId] = (state[siteId] ?? []).filter(
        (t) => !hashes.includes(t.hash),
      );
      cleared.push(...hashes.map((h) => `${siteId}/${h}`));
    },
  };
}

describe('createFirestoreScanner.getReferencedHashes', () => {
  it('reads the chunk list out of the R2 version body', async () => {
    // Regression (OWL-15): the version DOC has no `chunks` field — the finalize route
    // writes the hash list only into the R2 body. Reading the doc returned an empty
    // set, which makes every live chunk look like an orphan.
    const db = makeFakeDb({
      'site-1': { 'roost-a': { versions: ['v1', 'v2'] }, 'roost-b': { versions: ['v9'] } },
    });
    const r2 = makeFakeR2({
      [`${MANIFEST_BUCKET}/${versionKey('site-1', 'roost-a', 'v1')}`]: versionBody([
        hex(1),
        hex(2),
      ]),
      [`${MANIFEST_BUCKET}/${versionKey('site-1', 'roost-a', 'v2')}`]: versionBody([
        hex(2),
        hex(3),
      ]),
      [`${MANIFEST_BUCKET}/${versionKey('site-1', 'roost-b', 'v9')}`]: versionBody([
        hex(4),
      ]),
    });

    const scanner = createFirestoreScanner(db, r2.client, 'dev');
    const referenced = await scanner.getReferencedHashes('site-1');
    assert.deepEqual(
      [...referenced].sort(),
      [hex(1), hex(2), hex(3), hex(4)].sort(),
    );
  });

  it('throws when a version body is absent from R2', async () => {
    const db = makeFakeDb({ 'site-1': { 'roost-a': { versions: ['v1'] } } });
    const r2 = makeFakeR2({});
    const scanner = createFirestoreScanner(db, r2.client, 'dev');
    await assert.rejects(
      scanner.getReferencedHashes('site-1'),
      /version body missing in R2/,
    );
  });

  it('throws when a version body is not valid JSON', async () => {
    const db = makeFakeDb({ 'site-1': { 'roost-a': { versions: ['v1'] } } });
    const r2 = makeFakeR2({
      [`${MANIFEST_BUCKET}/${versionKey('site-1', 'roost-a', 'v1')}`]: '{ not json',
    });
    const scanner = createFirestoreScanner(db, r2.client, 'dev');
    await assert.rejects(
      scanner.getReferencedHashes('site-1'),
      /not valid JSON/,
    );
  });

  it('throws when a version body has an unexpected shape', async () => {
    const db = makeFakeDb({ 'site-1': { 'roost-a': { versions: ['v1'] } } });
    const r2 = makeFakeR2({
      [`${MANIFEST_BUCKET}/${versionKey('site-1', 'roost-a', 'v1')}`]:
        JSON.stringify({ schemaVersion: 3, files: [] }),
    });
    const scanner = createFirestoreScanner(db, r2.client, 'dev');
    await assert.rejects(
      scanner.getReferencedHashes('site-1'),
      /version body rejected/,
    );
  });

  it('reports an active rollout from the rollouts subcollection', async () => {
    const db = makeFakeDb({
      'site-1': { 'roost-a': { versions: [], activeRollout: true } },
    });
    const scanner = createFirestoreScanner(db, makeFakeR2({}).client, 'dev');
    assert.equal(await scanner.hasActiveRollout('site-1'), true);
  });
});

describe('createR2ObjectStore', () => {
  it('maps chunk keys back to hashes and ignores anything else', async () => {
    const r2 = makeFakeR2({
      [`${CONTENT_BUCKET}/${chunkKey('site-1', hex(1))}`]: 'x',
      [`${CONTENT_BUCKET}/${chunkKey('site-1', hex(2))}`]: 'x',
      // stray objects under the tenant prefix are never deletion candidates
      [`${CONTENT_BUCKET}/project-content/site-1/aa/README`]: 'x',
      [`${CONTENT_BUCKET}/project-content/site-1/notes.txt`]: 'x',
    });
    const store = createR2ObjectStore(r2.client, 'dev');
    const stored = await store.listStoredHashes('site-1');
    assert.deepEqual([...stored].sort(), [hex(1), hex(2)].sort());
  });

  it('deletes at the sharded key', async () => {
    const r2 = makeFakeR2({
      [`${CONTENT_BUCKET}/${chunkKey('site-1', hex(1))}`]: 'x',
    });
    await createR2ObjectStore(r2.client, 'dev').deleteChunk('site-1', hex(1));
    assert.deepEqual(r2.deleted, [
      `${CONTENT_BUCKET}/${chunkKey('site-1', hex(1))}`,
    ]);
  });
});

// full run: production scanner + production store + in-memory tombstones

interface RunFixture {
  db: FirebaseFirestore.Firestore;
  r2: FakeR2;
  tombstones: ReturnType<typeof memoryTombstones>;
  deps: GcDeps;
}

/**
 * site-1: one roost, one version referencing hex(1). hex(2) is stored but referenced
 * by nothing, and already carries a ripe tombstone — so a healthy apply-mode run
 * deletes exactly hex(2).
 */
function makeRunFixture(
  mode: GcMode,
  opts: { extraSites?: Record<string, Record<string, FakeRoost>>; extraObjects?: Record<string, string> } = {},
): RunFixture {
  const db = makeFakeDb({
    'site-1': { 'roost-a': { versions: ['v1'] } },
    ...(opts.extraSites ?? {}),
  });
  const r2 = makeFakeR2({
    [`${MANIFEST_BUCKET}/${versionKey('site-1', 'roost-a', 'v1')}`]: versionBody([
      hex(1),
    ]),
    [`${CONTENT_BUCKET}/${chunkKey('site-1', hex(1))}`]: 'live bytes',
    [`${CONTENT_BUCKET}/${chunkKey('site-1', hex(2))}`]: 'orphan bytes',
    ...(opts.extraObjects ?? {}),
  });
  const tombstones = memoryTombstones({
    'site-1': [{ hash: hex(2), tombstonedAt: NOW - TOMBSTONE_TTL_MS - 1 }],
  });
  return {
    db,
    r2,
    tombstones,
    deps: {
      scanner: createFirestoreScanner(db, r2.client, 'dev'),
      store: createR2ObjectStore(r2.client, 'dev'),
      tombstones,
      mode,
      now: () => new Date(NOW),
    },
  };
}

describe('gcAllSites (production wiring)', () => {
  it('deletes the orphan and leaves the referenced chunk alone', async () => {
    const fx = makeRunFixture('apply');
    const run = await gcAllSites(fx.deps);

    assert.equal(run.degraded, false);
    assert.deepEqual(run.degradedSites, []);
    assert.deepEqual(fx.r2.deleted, [
      `${CONTENT_BUCKET}/${chunkKey('site-1', hex(2))}`,
    ]);
    // the live chunk is still in storage — and was never even marked, which is the
    // assertion that goes red if the scan stops reading the R2 body.
    assert.ok(
      Object.prototype.hasOwnProperty.call(
        fx.r2.objects,
        `${CONTENT_BUCKET}/${chunkKey('site-1', hex(1))}`,
      ),
    );
    assert.deepEqual(fx.tombstones.created, []);
    assert.deepEqual(fx.tombstones.cleared, [`site-1/${hex(2)}`]);
  });

  it('a live chunk carrying a ripe tombstone is resurrected, not deleted', async () => {
    // The mass-deletion path: a prior run with a broken reference scan tombstoned a
    // chunk that is very much live. A working scan must clear the tombstone.
    const fx = makeRunFixture('apply');
    fx.deps.tombstones = memoryTombstones({
      'site-1': [
        { hash: hex(1), tombstonedAt: NOW - TOMBSTONE_TTL_MS - 1 },
        { hash: hex(2), tombstonedAt: NOW - TOMBSTONE_TTL_MS - 1 },
      ],
    });
    const run = await gcAllSites(fx.deps);

    assert.equal(run.degraded, false);
    assert.deepEqual(fx.r2.deleted, [
      `${CONTENT_BUCKET}/${chunkKey('site-1', hex(2))}`,
    ]);
    assert.ok(
      Object.prototype.hasOwnProperty.call(
        fx.r2.objects,
        `${CONTENT_BUCKET}/${chunkKey('site-1', hex(1))}`,
      ),
      'the live chunk must survive',
    );
  });

  it('tombstones a fresh orphan without deleting it', async () => {
    const fx = makeRunFixture('apply');
    // drop the pre-existing tombstone so hex(2) is seen for the first time
    fx.deps.tombstones = memoryTombstones();
    const run = await gcAllSites(fx.deps);

    assert.equal(run.degraded, false);
    assert.deepEqual(fx.r2.deleted, []);
    assert.equal(run.results[0].summary!.newTombstones, 1);
  });

  it('apply flag off (dry-run): deletes nothing even with a ripe orphan', async () => {
    const fx = makeRunFixture(resolveMode({}));
    assert.equal(fx.deps.mode, 'dry-run');
    const run = await gcAllSites(fx.deps);

    assert.equal(run.mode, 'dry-run');
    assert.deepEqual(fx.r2.deleted, []);
    assert.deepEqual(fx.tombstones.created, []);
    assert.deepEqual(fx.tombstones.cleared, []);
    // the plan still reports what apply mode WOULD have removed
    assert.equal(run.results[0].summary!.deletions, 1);
  });

  it('unparseable version body on one site vetoes deletions for the whole run', async () => {
    const fx = makeRunFixture('apply', {
      extraSites: { 'site-2': { 'roost-z': { versions: ['v1'] } } },
      extraObjects: {
        [`${MANIFEST_BUCKET}/${versionKey('site-2', 'roost-z', 'v1')}`]:
          '<html>not a manifest</html>',
        [`${CONTENT_BUCKET}/${chunkKey('site-2', hex(7))}`]: 'bytes',
      },
    });
    const run = await gcAllSites(fx.deps);

    assert.equal(run.degraded, true);
    assert.deepEqual(run.degradedSites, ['site-2']);
    // site-1 scanned cleanly and still had a ripe orphan — withheld anyway.
    assert.deepEqual(fx.r2.deleted, []);
    assert.equal(
      run.results.find((r) => r.siteId === 'site-1')!.deletionsWithheld,
      true,
    );
    // the failed site produced no plan and no writes at all
    const bad = run.results.find((r) => r.siteId === 'site-2')!;
    assert.equal(bad.skipped, true);
    assert.match(bad.skipReason!, /scan_error/);
    assert.deepEqual(
      fx.tombstones.created.filter((h) => h.startsWith('site-2/')),
      [],
    );
  });

  it('a missing version body vetoes deletions the same way', async () => {
    const fx = makeRunFixture('apply', {
      extraSites: { 'site-2': { 'roost-z': { versions: ['v1'] } } },
    });
    const run = await gcAllSites(fx.deps);

    assert.equal(run.degraded, true);
    assert.deepEqual(fx.r2.deleted, []);
  });

  it('an unreadable R2 listing vetoes deletions', async () => {
    const fx = makeRunFixture('apply');
    fx.r2.fail.add(`list:${CONTENT_BUCKET}/project-content/site-1/`);
    const run = await gcAllSites(fx.deps);

    assert.equal(run.degraded, true);
    assert.deepEqual(run.degradedSites, ['site-1']);
    assert.deepEqual(fx.r2.deleted, []);
  });

  it('an unreadable site listing aborts the run with no results', async () => {
    const db = makeFakeDb({}, { failSiteListing: true });
    const r2 = makeFakeR2({});
    const run = await gcAllSites({
      scanner: createFirestoreScanner(db, r2.client, 'dev'),
      store: createR2ObjectStore(r2.client, 'dev'),
      tombstones: memoryTombstones(),
      mode: 'apply',
      now: () => new Date(NOW),
    });

    assert.equal(run.degraded, true);
    assert.deepEqual(run.results, []);
    assert.deepEqual(r2.deleted, []);
  });

  it('a degraded run still maintains tombstones for cleanly-scanned sites', async () => {
    const fx = makeRunFixture('apply', {
      extraSites: { 'site-2': { 'roost-z': { versions: ['v1'] } } },
      extraObjects: {
        [`${CONTENT_BUCKET}/${chunkKey('site-1', hex(3))}`]: 'new orphan',
      },
    });
    const run = await gcAllSites(fx.deps);

    assert.equal(run.degraded, true);
    assert.deepEqual(fx.tombstones.created, [`site-1/${hex(3)}`]);
    assert.deepEqual(fx.r2.deleted, []);
  });
});
