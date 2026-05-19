/** @jest-environment node */

/**
 * Unit tests for `web/lib/fanOut.server.ts` (security-boundary-migration
 * wave 2.2). Mocks the firebase-admin Firestore client at the doc-ref
 * level — same approach as `commandLifecycle.test.ts` — so we can assert
 * exactly what the helper writes without booting the emulator.
 *
 * Key invariants under test:
 *   - per-target results returned in input order with correct `ok` flags
 *   - `auditCorrelationId` propagated into `metadata` of every entry
 *     (and also exposed as the top-level field stamped by 1.6)
 *   - chunking: 100 machines with chunk size 50 → exactly 2 batches
 *   - partial failures isolated; one bad machine does not abort the rest
 *   - builder throws are caught and surfaced as `ok: false`
 */

import { Timestamp } from 'firebase-admin/firestore';

// `getAdminDb` must be mocked at module load, even though every test in
// this file injects an explicit `db` — the helper resolves the default db
// once at the top of `fanOutToMachines`, so without the mock that branch
// would touch the real firebase-admin and crash under jsdom-derived test
// envs.
const defaultSetMock = jest.fn().mockResolvedValue(undefined);
const defaultBuildCollection = (): Record<string, unknown> => ({
  doc: jest.fn(() => ({
    set: defaultSetMock,
    collection: defaultBuildCollection,
  })),
});

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({ collection: defaultBuildCollection }),
}));

import {
  FANOUT_CHUNK_SIZE,
  fanOutToMachines,
  type CommandBuilder,
} from '@/lib/fanOut.server';
import type { FanOutResult } from '@/lib/commandLifecycle';

/**
 * `fanOutToMachines`'s `db` option is typed as the admin-SDK Firestore.
 * We extract that type to widen our test stubs without depending on
 * firebase-admin's full surface area.
 */
type FakeFirestore = NonNullable<Parameters<typeof fanOutToMachines>[0]['db']>;

interface RecordedCall {
  path: string[];
  payload: Record<string, unknown>;
  options?: { merge?: boolean };
}

/**
 * Build a fake admin-SDK Firestore that records every `.set()` call so a
 * test can assert the exact path and payload the helper produced. Mirrors
 * the helper used in `commandLifecycle.test.ts`.
 */
function buildFakeDb(
  shouldFail?: (machineId: string) => boolean,
): {
  db: FakeFirestore;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let lastMachineId: string | null = null;

  function makeCollection(parentPath: string[]): { doc: (id: string) => unknown } {
    return {
      doc: (id: string) => {
        const docPath = [...parentPath, id];
        // The path shape we care about is
        //   sites / {siteId} / machines / {machineId} / commands / pending
        // Track the most recent machine id as we descend so the optional
        // `shouldFail` predicate can branch on it.
        if (parentPath.length >= 1 && parentPath[parentPath.length - 1] === 'machines') {
          lastMachineId = id;
        }
        const stub = {
          set: jest.fn(
            async (payload: Record<string, unknown>, options?: { merge?: boolean }) => {
              calls.push({ path: docPath, payload, options });
              if (shouldFail && lastMachineId && shouldFail(lastMachineId)) {
                throw new Error(`forced_failure:${lastMachineId}`);
              }
            },
          ),
          collection: (name: string) => makeCollection([...docPath, name]),
        };
        return stub;
      },
    };
  }

  const db = { collection: (name: string) => makeCollection([name]) };
  return { db: db as unknown as FakeFirestore, calls };
}

const simpleBuilder: CommandBuilder = (machineId) => ({
  commandIdPrefix: 'restart',
  commandData: { type: 'restart_process', process_id: `p_${machineId}` },
});

/* -------------------------------------------------------------------------- */
/*  module shape                                                              */
/* -------------------------------------------------------------------------- */

describe('FANOUT_CHUNK_SIZE', () => {
  it('is exported as 50', () => {
    expect(FANOUT_CHUNK_SIZE).toBe(50);
  });
});

/* -------------------------------------------------------------------------- */
/*  happy paths                                                               */
/* -------------------------------------------------------------------------- */

describe('fanOutToMachines — all succeed', () => {
  it('returns one result per machine in input order with ok flags set', async () => {
    const { db, calls } = buildFakeDb();
    const results = await fanOutToMachines({
      siteId: 'site_a',
      machineIds: ['m1', 'm2', 'm3'],
      builder: simpleBuilder,
      correlationId: 'corr_1',
      db,
      now: () => 1_700_000_000_000,
    });

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.machineId)).toEqual(['m1', 'm2', 'm3']);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.every((r) => typeof r.commandId === 'string')).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('writes to the canonical pending path with merge: true', async () => {
    const { db, calls } = buildFakeDb();
    await fanOutToMachines({
      siteId: 'site_a',
      machineIds: ['m1'],
      builder: simpleBuilder,
      correlationId: 'corr_1',
      db,
      now: () => 1_700_000_000_000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toEqual([
      'sites',
      'site_a',
      'machines',
      'm1',
      'commands',
      'pending',
    ]);
    expect(calls[0].options).toEqual({ merge: true });
  });

  it('lets the builder vary commandIdPrefix and commandData per machine', async () => {
    const { db, calls } = buildFakeDb();
    const builder: CommandBuilder = (machineId) =>
      machineId === 'm1'
        ? { commandIdPrefix: 'restart', commandData: { type: 'restart_process' } }
        : { commandIdPrefix: 'kill', commandData: { type: 'kill_process' } };

    await fanOutToMachines({
      siteId: 'site_a',
      machineIds: ['m1', 'm2'],
      builder,
      correlationId: 'corr_1',
      db,
      now: () => 1,
    });

    expect(calls).toHaveLength(2);
    const [firstId] = Object.keys(calls[0].payload);
    const [secondId] = Object.keys(calls[1].payload);
    expect(firstId.startsWith('restart_')).toBe(true);
    expect(secondId.startsWith('kill_')).toBe(true);

    const firstEntry = calls[0].payload[firstId] as Record<string, unknown>;
    const secondEntry = calls[1].payload[secondId] as Record<string, unknown>;
    expect(firstEntry.type).toBe('restart_process');
    expect(secondEntry.type).toBe('kill_process');
  });
});

/* -------------------------------------------------------------------------- */
/*  correlation id propagation                                                */
/* -------------------------------------------------------------------------- */

describe('fanOutToMachines — correlation id', () => {
  it('injects auditCorrelationId into metadata of every command entry', async () => {
    const { db, calls } = buildFakeDb();
    await fanOutToMachines({
      siteId: 'site_a',
      machineIds: ['m1', 'm2', 'm3'],
      builder: simpleBuilder,
      correlationId: 'corr_42',
      db,
      now: () => 1,
    });

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      const [commandId] = Object.keys(call.payload);
      const entry = call.payload[commandId] as Record<string, unknown>;
      const metadata = entry.metadata as Record<string, unknown>;
      expect(metadata).toBeDefined();
      expect(metadata.auditCorrelationId).toBe('corr_42');
      // 1.6's stamper still emits the top-level field — kept for backward
      // compat with the audit pipeline. The metadata-side mirror is wave
      // 2.2's contract for routing/replay consumers.
      expect(entry.auditCorrelationId).toBe('corr_42');
    }
  });

  it('preserves caller-supplied metadata fields and only adds correlation id', async () => {
    const { db, calls } = buildFakeDb();
    const builder: CommandBuilder = () => ({
      commandIdPrefix: 'install',
      commandData: {
        type: 'install_software',
        metadata: { initiator: 'cron', batchTag: 'nightly' },
      },
    });

    await fanOutToMachines({
      siteId: 'site_a',
      machineIds: ['m1'],
      builder,
      correlationId: 'corr_99',
      db,
      now: () => 1,
    });

    const [commandId] = Object.keys(calls[0].payload);
    const entry = calls[0].payload[commandId] as Record<string, unknown>;
    expect(entry.metadata).toEqual({
      initiator: 'cron',
      batchTag: 'nightly',
      auditCorrelationId: 'corr_99',
    });
  });

  it('handles non-object metadata from builder by replacing it with a fresh object', async () => {
    const { db, calls } = buildFakeDb();
    // A builder that mistakenly emits a string as `metadata` should not
    // crash the helper — the wave-2.2 contract owns the slot, so we
    // overwrite cleanly rather than try to merge into a non-object.
    const builder: CommandBuilder = () => ({
      commandIdPrefix: 'noop',
      commandData: { type: 'noop', metadata: 'oops' as unknown as Record<string, unknown> },
    });

    await fanOutToMachines({
      siteId: 'site_a',
      machineIds: ['m1'],
      builder,
      correlationId: 'corr_99',
      db,
      now: () => 1,
    });

    const [commandId] = Object.keys(calls[0].payload);
    const entry = calls[0].payload[commandId] as Record<string, unknown>;
    expect(entry.metadata).toEqual({ auditCorrelationId: 'corr_99' });
  });
});

/* -------------------------------------------------------------------------- */
/*  chunking / concurrency                                                    */
/* -------------------------------------------------------------------------- */

describe('fanOutToMachines — chunking', () => {
  it('processes 100 machineIds in exactly 2 batches of 50 (sequential between batches)', async () => {
    // Track per-machine concurrency: we want to prove that batch N+1
    // doesn't start until batch N has fully resolved. Each `set()` waits
    // for a shared "release" signal; we count how many calls are in
    // flight at peak.
    let inFlight = 0;
    let peakInFlight = 0;
    const batchCallObservations: number[] = [];

    let releaseBatch: (() => void) | null = null;
    let pendingRelease: Promise<void> = new Promise((resolve) => {
      releaseBatch = resolve;
    });

    const fakeDb: FakeFirestore = {
      collection: () => ({
        doc: () => ({
          collection: () => ({
            doc: () => ({
              collection: () => ({
                doc: () => ({
                  set: jest.fn(async () => {
                    inFlight += 1;
                    peakInFlight = Math.max(peakInFlight, inFlight);
                    // When we hit the chunk size, snapshot how many calls
                    // are concurrent (== chunk size for full batches) and
                    // open the gate so the await below can resolve.
                    if (inFlight === FANOUT_CHUNK_SIZE) {
                      batchCallObservations.push(inFlight);
                      releaseBatch?.();
                    }
                    await pendingRelease;
                    inFlight -= 1;
                    if (inFlight === 0) {
                      // Re-arm for the next batch — fresh gate object.
                      pendingRelease = new Promise((resolve) => {
                        releaseBatch = resolve;
                      });
                    }
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    } as unknown as FakeFirestore;

    const machineIds = Array.from({ length: 100 }, (_, i) => `m${i}`);
    const results = await fanOutToMachines({
      siteId: 'site_a',
      machineIds,
      builder: simpleBuilder,
      correlationId: 'corr_chunk',
      db: fakeDb,
      now: () => 1,
    });

    expect(results).toHaveLength(100);
    expect(results.every((r) => r.ok)).toBe(true);
    // Two full batches of 50 concurrent calls — never more.
    expect(peakInFlight).toBe(FANOUT_CHUNK_SIZE);
    expect(batchCallObservations).toEqual([FANOUT_CHUNK_SIZE, FANOUT_CHUNK_SIZE]);
  });

  it('handles a partial last chunk (101 machines → 50 + 50 + 1)', async () => {
    const { db, calls } = buildFakeDb();
    const machineIds = Array.from({ length: 101 }, (_, i) => `m${i}`);
    const results = await fanOutToMachines({
      siteId: 'site_a',
      machineIds,
      builder: simpleBuilder,
      correlationId: 'corr_partial',
      db,
      now: () => 1,
    });

    expect(results).toHaveLength(101);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(calls).toHaveLength(101);
  });

  it('handles fleets smaller than one chunk in a single batch', async () => {
    const { db, calls } = buildFakeDb();
    const machineIds = Array.from({ length: 7 }, (_, i) => `m${i}`);
    const results = await fanOutToMachines({
      siteId: 'site_a',
      machineIds,
      builder: simpleBuilder,
      correlationId: 'corr_small',
      db,
      now: () => 1,
    });

    expect(results).toHaveLength(7);
    expect(calls).toHaveLength(7);
  });

  it('returns an empty array for an empty machineIds list without touching the db', async () => {
    const { db, calls } = buildFakeDb();
    const results = await fanOutToMachines({
      siteId: 'site_a',
      machineIds: [],
      builder: simpleBuilder,
      correlationId: 'corr_empty',
      db,
      now: () => 1,
    });

    expect(results).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  failure isolation                                                         */
/* -------------------------------------------------------------------------- */

describe('fanOutToMachines — failure modes', () => {
  it('partial failure: 7 succeed + 3 fail → all 10 results returned with correct ok flags', async () => {
    const failingIds = new Set(['m2', 'm5', 'm8']);
    const { db } = buildFakeDb((machineId) => failingIds.has(machineId));

    const machineIds = Array.from({ length: 10 }, (_, i) => `m${i}`);
    const results = await fanOutToMachines({
      siteId: 'site_a',
      machineIds,
      builder: simpleBuilder,
      correlationId: 'corr_partial_fail',
      db,
      now: () => 1,
    });

    expect(results).toHaveLength(10);
    const byId = new Map(results.map((r) => [r.machineId, r] as const));
    for (const id of machineIds) {
      const entry = byId.get(id) as FanOutResult;
      if (failingIds.has(id)) {
        expect(entry.ok).toBe(false);
        expect(entry.error).toContain('forced_failure');
      } else {
        expect(entry.ok).toBe(true);
        expect(typeof entry.commandId).toBe('string');
      }
    }
  });

  it('all fail: every machine surfaces ok: false with its error message', async () => {
    const { db } = buildFakeDb(() => true);
    const results = await fanOutToMachines({
      siteId: 'site_a',
      machineIds: ['m1', 'm2', 'm3'],
      builder: simpleBuilder,
      correlationId: 'corr_all_fail',
      db,
      now: () => 1,
    });

    expect(results).toHaveLength(3);
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(results.every((r) => typeof r.error === 'string' && r.error.length > 0)).toBe(true);
  });

  it('builder throws for one machine: surfaces as ok: false, others still write', async () => {
    const { db, calls } = buildFakeDb();
    const builder: CommandBuilder = (machineId) => {
      if (machineId === 'invalid') {
        throw new Error('unsupported_machine_capability');
      }
      return { commandIdPrefix: 'restart', commandData: { type: 'restart_process' } };
    };

    const results = await fanOutToMachines({
      siteId: 'site_a',
      machineIds: ['good-1', 'invalid', 'good-2'],
      builder,
      correlationId: 'corr_bad_builder',
      db,
      now: () => 1,
    });

    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ machineId: 'good-1', ok: true });
    expect(results[1]).toMatchObject({
      machineId: 'invalid',
      ok: false,
      error: 'unsupported_machine_capability',
    });
    expect(results[2]).toMatchObject({ machineId: 'good-2', ok: true });
    // Only the two valid machines should have produced writes.
    expect(calls).toHaveLength(2);
  });

  it('isolates per-batch failures across chunk boundaries', async () => {
    // Fail every machine in the second batch (m50..m99). The first batch
    // must still resolve cleanly — no abort propagation across batches.
    const { db } = buildFakeDb((machineId) => {
      const n = Number(machineId.slice(1));
      return n >= 50;
    });

    const machineIds = Array.from({ length: 100 }, (_, i) => `m${i}`);
    const results = await fanOutToMachines({
      siteId: 'site_a',
      machineIds,
      builder: simpleBuilder,
      correlationId: 'corr_split',
      db,
      now: () => 1,
    });

    expect(results).toHaveLength(100);
    const okCount = results.filter((r) => r.ok).length;
    const failCount = results.filter((r) => !r.ok).length;
    expect(okCount).toBe(50);
    expect(failCount).toBe(50);
  });
});

/* -------------------------------------------------------------------------- */
/*  validation                                                                */
/* -------------------------------------------------------------------------- */

describe('fanOutToMachines — input validation', () => {
  it('rejects a missing siteId', async () => {
    await expect(
      fanOutToMachines({
        siteId: '',
        machineIds: ['m1'],
        builder: simpleBuilder,
        correlationId: 'corr_1',
      }),
    ).rejects.toThrow('siteId');
  });

  it('rejects a missing correlationId', async () => {
    await expect(
      fanOutToMachines({
        siteId: 'site_a',
        machineIds: ['m1'],
        builder: simpleBuilder,
        correlationId: '',
      }),
    ).rejects.toThrow('correlationId');
  });

  it('rejects a non-function builder', async () => {
    await expect(
      fanOutToMachines({
        siteId: 'site_a',
        machineIds: ['m1'],
        // Force the wrong type through the boundary — production callers
        // can't reach this case under tsc, but runtime callers (e.g. JS
        // tests, dynamic imports) can.
        builder: undefined as unknown as CommandBuilder,
        correlationId: 'corr_1',
      }),
    ).rejects.toThrow('builder');
  });
});

/* -------------------------------------------------------------------------- */
/*  default db fallback                                                       */
/* -------------------------------------------------------------------------- */

describe('fanOutToMachines — default db fallback', () => {
  it('falls back to getAdminDb() when no db is injected', async () => {
    defaultSetMock.mockClear();
    const results = await fanOutToMachines({
      siteId: 'site_a',
      machineIds: ['mach-only'],
      builder: () => ({
        commandIdPrefix: 'kill',
        commandData: { type: 'kill_process' },
      }),
      correlationId: 'corr_default',
      now: () => 7,
    });

    expect(results).toEqual([
      { machineId: 'mach-only', ok: true, commandId: 'kill_mach_only_7' },
    ]);
    expect(defaultSetMock).toHaveBeenCalledTimes(1);
    const [payload, options] = defaultSetMock.mock.calls[0];
    expect(options).toEqual({ merge: true });
    const [commandId] = Object.keys(payload);
    expect(commandId).toBe('kill_mach_only_7');
    const entry = (payload as Record<string, unknown>)[commandId] as Record<string, unknown>;
    expect((entry.metadata as Record<string, unknown>).auditCorrelationId).toBe('corr_default');
    expect(entry.expiresAt).toBeInstanceOf(Timestamp);
  });
});
