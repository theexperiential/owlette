/** @jest-environment node */

/**
 * Unit tests for `web/lib/actions/removeMachine.server.ts` (security-
 * boundary-migration wave 3.8).
 *
 * Verifies the four-path cascade — the same paths the legacy client hook
 * `useMachineOperations.ts` was deleting — and that missing
 * `commands/pending` / `commands/completed` docs are tolerated.
 *
 * Authorization (superadmin-only via `MACHINE_REMOVE`) is enforced by the
 * `authorizedSiteHandler` wrapper in the route, not by the action core,
 * so the auth tests live alongside the route shim and the existing
 * `authorizedHandler.test.ts` suite.
 */

const loggerWarnSpy = jest.fn();
const loggerErrorSpy = jest.fn();
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: () => {},
    info: () => {},
    warn: (...a: unknown[]) => loggerWarnSpy(...a),
    error: (...a: unknown[]) => loggerErrorSpy(...a),
  },
}));

// `removeMachine` resolves the default db once at the top of its body,
// so the firebase-admin mock must be in place before import even though
// every test injects an explicit `db`.
jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({ collection: () => ({ doc: () => ({}) }) }),
}));

import { removeMachine } from '@/lib/actions/removeMachine.server';

interface RecordedDelete {
  path: string;
}

interface BatchOp {
  op: 'delete';
  path: string;
}

interface FakeDbResult {
  // Helper exposes the path of every individual `.delete()` call (Phase 2).
  individualDeletes: RecordedDelete[];
  // Plus the ordered list of batch ops + commit invocations (Phase 1).
  batchOps: BatchOp[];
  batchCommitCount: number;
  // Make a specific path's individual delete throw to test fault isolation.
  setIndividualDeleteFailure: (path: string, err: Error) => void;
  // Make the batch commit throw to test main-cascade failure mode.
  setBatchCommitFailure: (err: Error) => void;
  // The fake db itself, typed loosely — the action core casts to its
  // import of `Firestore`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
}

function buildFakeDb(): FakeDbResult {
  const individualDeletes: RecordedDelete[] = [];
  const batchOps: BatchOp[] = [];
  let batchCommitCount = 0;
  const individualFailures = new Map<string, Error>();
  let batchFailure: Error | null = null;

  function makeDocRef(docPath: string): unknown {
    return {
      path: docPath,
      collection: (sub: string) => makeCollectionRef(`${docPath}/${sub}`),
      delete: async () => {
        const failure = individualFailures.get(docPath);
        if (failure) throw failure;
        individualDeletes.push({ path: docPath });
      },
    };
  }

  function makeCollectionRef(colPath: string): unknown {
    return {
      doc: (id: string) => makeDocRef(`${colPath}/${id}`),
    };
  }

  function makeBatch(): unknown {
    const localOps: BatchOp[] = [];
    return {
      delete: (ref: { path: string }) => {
        localOps.push({ op: 'delete', path: ref.path });
      },
      commit: async () => {
        if (batchFailure) throw batchFailure;
        batchOps.push(...localOps);
        batchCommitCount += 1;
      },
    };
  }

  const db = {
    collection: (name: string) => makeCollectionRef(name),
    batch: () => makeBatch(),
  };

  return {
    individualDeletes,
    batchOps,
    get batchCommitCount() {
      return batchCommitCount;
    },
    setIndividualDeleteFailure: (path, err) => {
      individualFailures.set(path, err);
    },
    setBatchCommitFailure: (err) => {
      batchFailure = err;
    },
    db,
  };
}

beforeEach(() => {
  loggerWarnSpy.mockClear();
  loggerErrorSpy.mockClear();
});

describe('removeMachine — input validation', () => {
  it('throws when siteId is empty', async () => {
    const fake = buildFakeDb();
    await expect(
      removeMachine({ siteId: '', machineId: 'm1', db: fake.db }),
    ).rejects.toThrow(/siteId/);
    expect(fake.batchCommitCount).toBe(0);
  });

  it('throws when machineId is empty', async () => {
    const fake = buildFakeDb();
    await expect(
      removeMachine({ siteId: 'site-a', machineId: '', db: fake.db }),
    ).rejects.toThrow(/machineId/);
    expect(fake.batchCommitCount).toBe(0);
  });
});

describe('removeMachine — cascade covers all 4 paths', () => {
  it('deletes machine + config in a batch and pending + completed individually', async () => {
    const fake = buildFakeDb();
    const result = await removeMachine({
      siteId: 'site-a',
      machineId: 'mach_alpha',
      db: fake.db,
    });

    // Phase 1 (atomic batch): main machine doc + config doc.
    expect(fake.batchCommitCount).toBe(1);
    expect(fake.batchOps).toEqual([
      { op: 'delete', path: 'sites/site-a/machines/mach_alpha' },
      { op: 'delete', path: 'config/site-a/machines/mach_alpha' },
    ]);

    // Phase 2 (best-effort): pending + completed command maps.
    const individualPaths = fake.individualDeletes.map((d) => d.path).sort();
    expect(individualPaths).toEqual([
      'sites/site-a/machines/mach_alpha/commands/completed',
      'sites/site-a/machines/mach_alpha/commands/pending',
    ]);

    // Result reports all 4 paths regardless of pre-existence.
    expect(result).toEqual({
      siteId: 'site-a',
      machineId: 'mach_alpha',
      deleted: {
        machine: 'sites/site-a/machines/mach_alpha',
        config: 'config/site-a/machines/mach_alpha',
        pendingCommands: 'sites/site-a/machines/mach_alpha/commands/pending',
        completedCommands: 'sites/site-a/machines/mach_alpha/commands/completed',
      },
    });
  });

  it('phase 1 batch runs BEFORE phase 2 best-effort deletes', async () => {
    const fake = buildFakeDb();
    // The batch commit failing should short-circuit before any
    // individual delete is attempted.
    fake.setBatchCommitFailure(new Error('batch_blew_up'));

    await expect(
      removeMachine({ siteId: 'site-a', machineId: 'm1', db: fake.db }),
    ).rejects.toThrow('batch_blew_up');

    expect(fake.individualDeletes).toEqual([]);
    expect(loggerWarnSpy).not.toHaveBeenCalled();
  });
});

describe('removeMachine — best-effort tolerance', () => {
  it('treats pending commands delete failure as non-fatal and logs warning', async () => {
    const fake = buildFakeDb();
    fake.setIndividualDeleteFailure(
      'sites/site-a/machines/m1/commands/pending',
      new Error('pending_doc_gone'),
    );

    const result = await removeMachine({
      siteId: 'site-a',
      machineId: 'm1',
      db: fake.db,
    });

    // The completed delete should still have been attempted + recorded.
    expect(fake.individualDeletes).toEqual([
      { path: 'sites/site-a/machines/m1/commands/completed' },
    ]);
    expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
    expect(loggerWarnSpy.mock.calls[0][0]).toMatch(/pending commands delete/);
    // The result still reports all four paths (caller treats this as success).
    expect(result.deleted.pendingCommands).toBe(
      'sites/site-a/machines/m1/commands/pending',
    );
  });

  it('treats completed commands delete failure as non-fatal and logs warning', async () => {
    const fake = buildFakeDb();
    fake.setIndividualDeleteFailure(
      'sites/site-a/machines/m1/commands/completed',
      new Error('completed_doc_gone'),
    );

    const result = await removeMachine({
      siteId: 'site-a',
      machineId: 'm1',
      db: fake.db,
    });

    expect(fake.individualDeletes).toEqual([
      { path: 'sites/site-a/machines/m1/commands/pending' },
    ]);
    expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
    expect(loggerWarnSpy.mock.calls[0][0]).toMatch(/completed commands delete/);
    expect(result.deleted.completedCommands).toBe(
      'sites/site-a/machines/m1/commands/completed',
    );
  });

  it('is idempotent: re-running on the same machineId is a no-op', async () => {
    const fake = buildFakeDb();
    await removeMachine({
      siteId: 'site-a',
      machineId: 'm1',
      db: fake.db,
    });
    await removeMachine({
      siteId: 'site-a',
      machineId: 'm1',
      db: fake.db,
    });
    // Two batches committed; eight delete-records (4 per call).
    expect(fake.batchCommitCount).toBe(2);
    expect(fake.batchOps).toHaveLength(4);
    expect(fake.individualDeletes).toHaveLength(4);
  });
});

describe('removeMachine — return shape', () => {
  it('returns the canonical 4 firestore paths in the deleted block', async () => {
    const fake = buildFakeDb();
    const result = await removeMachine({
      siteId: 'site-with_dashes-and_underscores',
      machineId: 'mach_42-x',
      db: fake.db,
    });
    expect(result.deleted).toEqual({
      machine: 'sites/site-with_dashes-and_underscores/machines/mach_42-x',
      config: 'config/site-with_dashes-and_underscores/machines/mach_42-x',
      pendingCommands:
        'sites/site-with_dashes-and_underscores/machines/mach_42-x/commands/pending',
      completedCommands:
        'sites/site-with_dashes-and_underscores/machines/mach_42-x/commands/completed',
    });
  });
});
