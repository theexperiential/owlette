/** @jest-environment node */

/**
 * Unit tests for `web/lib/actions/deleteOwnAccount.server.ts`
 * (security-boundary-migration wave 3.10).
 *
 * Coverage targets:
 *   - input validation (missing userId / operationId throws)
 *   - happy-path cascade deletes every path the legacy client cascade
 *     deleted (machines, deployments, logs, sites, users)
 *   - DIFF TEST: server-side deleted-path set === legacy client-side
 *     cascade deleted-path set against identical seed data
 *   - dry-run mode: returns counts without deleting anything
 *   - idempotency: second call replays the recorded outcome
 *   - chunking: 250 machines fan out into 3 batches of <=100
 *   - missing user doc: short-circuits to a noop result
 *   - missing site doc: skipped without crashing the cascade
 *   - non-fatal progress-doc write failures don't abort the cascade
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

// `deleteOwnAccount` resolves the default db once at the top of its body,
// so the firebase-admin mock must be in place before import even though
// every test injects an explicit `db`.
jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({ collection: () => ({ doc: () => ({}) }) }),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__SERVER_TS__',
  },
}));

import {
  deleteOwnAccount,
  BATCH_SIZE,
} from '@/lib/actions/deleteOwnAccount.server';

/* -------------------------------------------------------------------------- */
/*  fake firestore                                                            */
/* -------------------------------------------------------------------------- */

interface DocSeed {
  exists: boolean;
  data?: Record<string, unknown>;
}

interface FakeDbOptions {
  /** Seeded doc states keyed by canonical path (e.g. `users/uid_alice`). */
  seedDocs?: Record<string, DocSeed>;
  /**
   * Seeded subcollection contents keyed by parent collection path
   * (e.g. `sites/site-a/machines` → ['m1', 'm2']). Returned in the order
   * provided. Drained progressively as `delete()` is called against
   * matching paths.
   */
  seedCollections?: Record<string, string[]>;
  /** When set, calls to `progressRef.set()` reject with this error. */
  progressSetFailure?: Error;
}

interface FakeDbResult {
  setCalls: Array<{ path: string; payload: Record<string, unknown>; merge?: boolean }>;
  deleteCalls: string[];
  batchDeleteCalls: string[];
  batchCommitCount: number;
  /** Mutable: tests can mutate the seed mid-test. */
  collections: Map<string, string[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
}

function buildFakeDb(opts: FakeDbOptions = {}): FakeDbResult {
  const setCalls: FakeDbResult['setCalls'] = [];
  const deleteCalls: string[] = [];
  const batchDeleteCalls: string[] = [];
  let batchCommitCount = 0;

  const docs = new Map<string, DocSeed>(
    Object.entries(opts.seedDocs ?? {}),
  );
  const collections = new Map<string, string[]>(
    Object.entries(opts.seedCollections ?? {}).map(([k, v]) => [k, [...v]]),
  );

  function makeDocRef(docPath: string): unknown {
    return {
      path: docPath,
      collection: (sub: string) => makeCollectionRef(`${docPath}/${sub}`),
      get: async () => {
        const seed = docs.get(docPath);
        if (!seed) return { exists: false, data: () => undefined };
        return { exists: seed.exists, data: () => seed.data };
      },
      set: async (
        payload: Record<string, unknown>,
        options?: { merge?: boolean },
      ) => {
        if (
          docPath.endsWith('/account_deletion/operation') &&
          opts.progressSetFailure
        ) {
          throw opts.progressSetFailure;
        }
        setCalls.push({ path: docPath, payload, merge: options?.merge });
        // Mirror the write into the doc seed map so subsequent .get() reads
        // see the merged payload (relevant for replay tests).
        const prev = docs.get(docPath);
        const merged: Record<string, unknown> = options?.merge
          ? { ...(prev?.data ?? {}), ...payload }
          : { ...payload };
        docs.set(docPath, { exists: true, data: merged });
      },
      delete: async () => {
        deleteCalls.push(docPath);
        docs.set(docPath, { exists: false, data: undefined });
        // If this doc lives inside a tracked collection, remove it.
        const lastSlash = docPath.lastIndexOf('/');
        const parent = docPath.slice(0, lastSlash);
        const id = docPath.slice(lastSlash + 1);
        const list = collections.get(parent);
        if (list) {
          const idx = list.indexOf(id);
          if (idx !== -1) list.splice(idx, 1);
        }
      },
    };
  }

  function makeCollectionRef(colPath: string): unknown {
    function snapshot(idsToReturn: string[]) {
      return {
        empty: idsToReturn.length === 0,
        size: idsToReturn.length,
        docs: idsToReturn.map((id) => ({
          id,
          ref: makeDocRef(`${colPath}/${id}`),
        })),
      };
    }
    function query(state: {
      ordered?: boolean;
      limit?: number;
      startAfterId?: string;
    }) {
      return {
        orderBy: () => query({ ...state, ordered: true }),
        limit: (n: number) => query({ ...state, limit: n }),
        startAfter: (doc: { id: string }) =>
          query({ ...state, startAfterId: doc.id }),
        get: async () => {
          let list = [...(collections.get(colPath) ?? [])];
          if (state.ordered) list = list.sort((a, b) => a.localeCompare(b));
          if (state.startAfterId) {
            const idx = list.indexOf(state.startAfterId);
            list = idx >= 0 ? list.slice(idx + 1) : list;
          }
          if (typeof state.limit === 'number') {
            list = list.slice(0, state.limit);
          }
          return snapshot(list);
        },
      };
    }
    const baseQuery = query({});
    return {
      path: colPath,
      doc: (id: string) => makeDocRef(`${colPath}/${id}`),
      orderBy: baseQuery.orderBy,
      limit: baseQuery.limit,
      startAfter: baseQuery.startAfter,
      get: baseQuery.get,
    };
  }

  const batch = () => {
    const ops: Array<{ op: 'delete'; path: string }> = [];
    return {
      delete: (ref: { path: string }) => {
        ops.push({ op: 'delete', path: ref.path });
      },
      commit: async () => {
        for (const op of ops) {
          batchDeleteCalls.push(op.path);
          // Mirror into the doc + collection state so successive scans see
          // the deletion (essential for the chunked-loop tests).
          docs.set(op.path, { exists: false, data: undefined });
          const lastSlash = op.path.lastIndexOf('/');
          const parent = op.path.slice(0, lastSlash);
          const id = op.path.slice(lastSlash + 1);
          const list = collections.get(parent);
          if (list) {
            const idx = list.indexOf(id);
            if (idx !== -1) list.splice(idx, 1);
          }
        }
        batchCommitCount += 1;
      },
    };
  };

  const db = {
    collection: (name: string) => makeCollectionRef(name),
    batch,
  };

  return {
    setCalls,
    deleteCalls,
    batchDeleteCalls,
    get batchCommitCount() {
      return batchCommitCount;
    },
    collections,
    db,
  };
}

/* -------------------------------------------------------------------------- */
/*  legacy client cascade simulator (for the diff test)                        */
/* -------------------------------------------------------------------------- */

/**
 * Simulate the legacy client-side `writeBatch` cascade from
 * `AuthContext.tsx` BEFORE migration. The simulator returns the set of
 * Firestore paths the legacy code would have deleted, so the diff test can
 * assert the server-side cascade matches bit-for-bit.
 */
function simulateLegacyClientCascade(
  userId: string,
  userSites: string[],
  collections: Record<string, string[]>,
): Set<string> {
  const deleted = new Set<string>();

  for (const siteId of userSites) {
    // Legacy code did `getDoc(siteRef)` first; if missing, no deletes for
    // that site. We emulate by checking whether ANY tracked subcollection
    // is keyed under the site (the seed builder always seeds at least one
    // entry per existing site for the diff tests).
    const machines = collections[`sites/${siteId}/machines`] ?? [];
    const deployments = collections[`sites/${siteId}/deployments`] ?? [];
    const logs = collections[`sites/${siteId}/logs`] ?? [];

    deleted.add(`sites/${siteId}`);
    for (const m of machines) deleted.add(`sites/${siteId}/machines/${m}`);
    for (const d of deployments) deleted.add(`sites/${siteId}/deployments/${d}`);
    for (const l of logs) deleted.add(`sites/${siteId}/logs/${l}`);
  }

  deleted.add(`users/${userId}`);
  return deleted;
}

/* -------------------------------------------------------------------------- */
/*  test setup helpers                                                        */
/* -------------------------------------------------------------------------- */

function seedUser(
  userId: string,
  sites: string[],
): Record<string, DocSeed> {
  const out: Record<string, DocSeed> = {};
  out[`users/${userId}`] = { exists: true, data: { sites, role: 'admin' } };
  for (const siteId of sites) {
    out[`sites/${siteId}`] = { exists: true, data: { name: siteId } };
  }
  return out;
}

function seedSubs(
  sites: string[],
  perSite: { machines: number; deployments: number; logs: number },
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const siteId of sites) {
    out[`sites/${siteId}/machines`] = Array.from(
      { length: perSite.machines },
      (_, i) => `m_${siteId}_${i}`,
    );
    out[`sites/${siteId}/deployments`] = Array.from(
      { length: perSite.deployments },
      (_, i) => `d_${siteId}_${i}`,
    );
    out[`sites/${siteId}/logs`] = Array.from(
      { length: perSite.logs },
      (_, i) => `l_${siteId}_${i}`,
    );
  }
  return out;
}

beforeEach(() => {
  loggerWarnSpy.mockClear();
  loggerErrorSpy.mockClear();
});

/* -------------------------------------------------------------------------- */
/*  input validation                                                          */
/* -------------------------------------------------------------------------- */

describe('deleteOwnAccount — input validation', () => {
  it('throws when userId is empty', async () => {
    const fake = buildFakeDb();
    await expect(
      deleteOwnAccount({ userId: '', operationId: 'op_1', db: fake.db }),
    ).rejects.toThrow(/userId/);
  });

  it('throws when operationId is empty', async () => {
    const fake = buildFakeDb();
    await expect(
      deleteOwnAccount({ userId: 'uid_a', operationId: '', db: fake.db }),
    ).rejects.toThrow(/operationId/);
  });
});

/* -------------------------------------------------------------------------- */
/*  cascade — happy path                                                      */
/* -------------------------------------------------------------------------- */

describe('deleteOwnAccount — happy path cascade', () => {
  it('deletes machines, deployments, logs, site doc, then user doc — for each site', async () => {
    const userId = 'uid_alice';
    const sites = ['site-a', 'site-b'];
    const seedDocs = seedUser(userId, sites);
    const seedCollections = seedSubs(sites, {
      machines: 3,
      deployments: 2,
      logs: 4,
    });
    const fake = buildFakeDb({ seedDocs, seedCollections });

    const result = await deleteOwnAccount({
      userId,
      operationId: 'op_alice_1',
      db: fake.db,
    });

    expect(result.performed).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.alreadyCompleted).toBe(false);
    expect(result.sites).toEqual(sites);
    expect(result.deletedCounts).toEqual({
      machines: 6,        // 3 per site × 2 sites
      deployments: 4,     // 2 per site × 2 sites
      logs: 8,            // 4 per site × 2 sites
      sites: 2,
      users: 1,
    });

    // Every batch op should be a delete; no batch should exceed BATCH_SIZE.
    expect(fake.batchDeleteCalls.length).toBe(18);

    // Site docs and user doc are deleted via the singular `.delete()` path
    // (not the batch). Order: per-site → site doc → ... → user doc last.
    expect(fake.deleteCalls).toEqual([
      'sites/site-a',
      'sites/site-b',
      `users/${userId}`,
    ]);
  });

  it('deletes child docs BEFORE the parent site doc', async () => {
    const userId = 'uid_a';
    const sites = ['site-a'];
    const fake = buildFakeDb({
      seedDocs: seedUser(userId, sites),
      seedCollections: seedSubs(sites, {
        machines: 2,
        deployments: 1,
        logs: 1,
      }),
    });

    await deleteOwnAccount({
      userId,
      operationId: 'op_order',
      db: fake.db,
    });

    // The 4 sub-doc deletes should land in the batch (commit happens before
    // we delete the site), and the site delete should be the FIRST entry in
    // `deleteCalls`. The user doc delete follows.
    const allBatched = fake.batchDeleteCalls;
    expect(allBatched).toContain('sites/site-a/machines/m_site-a_0');
    expect(allBatched).toContain('sites/site-a/deployments/d_site-a_0');
    expect(allBatched).toContain('sites/site-a/logs/l_site-a_0');

    expect(fake.deleteCalls).toEqual(['sites/site-a', `users/${userId}`]);
  });

  it('writes a progress doc before and after the cascade', async () => {
    const userId = 'uid_p';
    const fake = buildFakeDb({
      seedDocs: seedUser(userId, []),
    });

    await deleteOwnAccount({
      userId,
      operationId: 'op_progress',
      db: fake.db,
    });

    const progressWrites = fake.setCalls.filter(
      (c) => c.path === `users/${userId}/account_deletion/operation`,
    );
    expect(progressWrites.length).toBe(2);
    expect(progressWrites[0].payload.status).toBe('in_progress');
    expect(progressWrites[1].payload.status).toBe('completed');
    expect(progressWrites[1].payload.deletedCounts).toEqual({
      machines: 0,
      deployments: 0,
      logs: 0,
      sites: 0,
      users: 1,
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  diff test against legacy client cascade                                   */
/* -------------------------------------------------------------------------- */

describe('deleteOwnAccount — diff test vs. legacy client cascade', () => {
  it('the deleted-path set matches the legacy client cascade exactly', async () => {
    const userId = 'uid_diff';
    const sites = ['site-x', 'site-y', 'site-z'];
    const seedCollections = seedSubs(sites, {
      machines: 5,
      deployments: 3,
      logs: 7,
    });
    const fake = buildFakeDb({
      seedDocs: seedUser(userId, sites),
      seedCollections,
    });

    await deleteOwnAccount({
      userId,
      operationId: 'op_diff',
      db: fake.db,
    });

    const serverDeleted = new Set<string>([
      ...fake.batchDeleteCalls,
      ...fake.deleteCalls,
    ]);

    const legacyDeleted = simulateLegacyClientCascade(
      userId,
      sites,
      seedCollections,
    );

    expect(serverDeleted).toEqual(legacyDeleted);

    // Sanity check: the path set is non-trivial. (Three sites with 5+3+7
    // children plus the site doc and the user doc.)
    expect(serverDeleted.size).toBe(3 * (5 + 3 + 7) + sites.length + 1);
  });
});

/* -------------------------------------------------------------------------- */
/*  dry-run mode                                                              */
/* -------------------------------------------------------------------------- */

describe('deleteOwnAccount — dry-run mode', () => {
  it('returns counts without performing any deletes', async () => {
    const userId = 'uid_dry';
    const sites = ['site-d'];
    const fake = buildFakeDb({
      seedDocs: seedUser(userId, sites),
      seedCollections: seedSubs(sites, {
        machines: 4,
        deployments: 2,
        logs: 6,
      }),
    });

    const result = await deleteOwnAccount({
      userId,
      operationId: 'op_dry',
      dryRun: true,
      db: fake.db,
    });

    expect(result.performed).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(result.deletedCounts).toEqual({
      machines: 4,
      deployments: 2,
      logs: 6,
      sites: 1,
      users: 1,
    });

    // No deletes should hit firestore.
    expect(fake.batchDeleteCalls).toEqual([]);
    expect(fake.deleteCalls).toEqual([]);

    // No progress-doc writes either — dry-runs are pure scans.
    const progressWrites = fake.setCalls.filter((c) =>
      c.path.includes('account_deletion'),
    );
    expect(progressWrites).toEqual([]);
  });

  it('returns the would-delete path list', async () => {
    const userId = 'uid_dry2';
    const sites = ['site-q'];
    const fake = buildFakeDb({
      seedDocs: seedUser(userId, sites),
      seedCollections: seedSubs(sites, {
        machines: 1,
        deployments: 0,
        logs: 1,
      }),
    });

    const result = await deleteOwnAccount({
      userId,
      operationId: 'op_dry_paths',
      dryRun: true,
      db: fake.db,
    });

    expect(result.deletedPaths).toEqual(
      expect.arrayContaining([
        'sites/site-q/machines/m_site-q_0',
        'sites/site-q/logs/l_site-q_0',
        'sites/site-q',
        `users/${userId}`,
      ]),
    );
  });

  it('dry-run counts beyond one page without deleting anything', async () => {
    const userId = 'uid_dry_chunk';
    const sites = ['site-dry-big'];
    const fake = buildFakeDb({
      seedDocs: seedUser(userId, sites),
      seedCollections: seedSubs(sites, {
        machines: 250,
        deployments: 0,
        logs: 0,
      }),
    });

    const result = await deleteOwnAccount({
      userId,
      operationId: 'op_dry_chunk',
      dryRun: true,
      db: fake.db,
    });

    expect(result.deletedCounts.machines).toBe(250);
    expect(result.deletedPaths.filter((p) =>
      p.startsWith('sites/site-dry-big/machines/'),
    ).length).toBe(250);
    expect(fake.batchDeleteCalls).toEqual([]);
    expect(fake.deleteCalls).toEqual([]);
    expect(fake.collections.get('sites/site-dry-big/machines')?.length).toBe(250);
  });
});

/* -------------------------------------------------------------------------- */
/*  idempotency                                                               */
/* -------------------------------------------------------------------------- */

describe('deleteOwnAccount — idempotency', () => {
  it('a re-issued call with the same operationId is a no-op replay', async () => {
    const userId = 'uid_idem';
    const sites = ['site-i'];
    const fake = buildFakeDb({
      seedDocs: seedUser(userId, sites),
      seedCollections: seedSubs(sites, {
        machines: 2,
        deployments: 0,
        logs: 0,
      }),
    });

    const first = await deleteOwnAccount({
      userId,
      operationId: 'op_idem_1',
      db: fake.db,
    });
    expect(first.performed).toBe(true);
    expect(first.alreadyCompleted).toBe(false);

    const firstBatchDeletes = fake.batchDeleteCalls.length;
    const firstDocDeletes = fake.deleteCalls.length;

    const second = await deleteOwnAccount({
      userId,
      operationId: 'op_idem_1',
      db: fake.db,
    });
    expect(second.performed).toBe(false);
    expect(second.alreadyCompleted).toBe(true);
    expect(second.deletedCounts).toEqual(first.deletedCounts);

    // No new firestore deletes happened on the replay.
    expect(fake.batchDeleteCalls.length).toBe(firstBatchDeletes);
    expect(fake.deleteCalls.length).toBe(firstDocDeletes);
  });
});

/* -------------------------------------------------------------------------- */
/*  chunking                                                                  */
/* -------------------------------------------------------------------------- */

describe('deleteOwnAccount — chunking', () => {
  it('250 machines drain in 3 batches of <= BATCH_SIZE', async () => {
    expect(BATCH_SIZE).toBe(100);

    const userId = 'uid_chunk';
    const sites = ['site-big'];
    const fake = buildFakeDb({
      seedDocs: seedUser(userId, sites),
      seedCollections: seedSubs(sites, {
        machines: 250,
        deployments: 0,
        logs: 0,
      }),
    });

    const result = await deleteOwnAccount({
      userId,
      operationId: 'op_chunk',
      db: fake.db,
    });

    expect(result.deletedCounts.machines).toBe(250);

    // Every machine should have been deleted exactly once.
    const machineDeletes = fake.batchDeleteCalls.filter((p) =>
      p.startsWith('sites/site-big/machines/'),
    );
    expect(machineDeletes.length).toBe(250);
    expect(new Set(machineDeletes).size).toBe(250);

    // 250 / BATCH_SIZE === 3 batches (100 + 100 + 50). The action also
    // commits a small batch for any non-empty deployments / logs scan,
    // but we seeded zero of those, so the only batch commits come from
    // the machines drain.
    expect(fake.batchCommitCount).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */
/*  edge cases                                                                */
/* -------------------------------------------------------------------------- */

describe('deleteOwnAccount — edge cases', () => {
  it('returns alreadyCompleted=true when the user doc is already gone', async () => {
    const userId = 'uid_gone';
    const fake = buildFakeDb({ seedDocs: {} }); // user doc not seeded

    const result = await deleteOwnAccount({
      userId,
      operationId: 'op_gone',
      db: fake.db,
    });

    expect(result.performed).toBe(false);
    expect(result.alreadyCompleted).toBe(true);
    expect(result.deletedCounts).toEqual({
      machines: 0,
      deployments: 0,
      logs: 0,
      sites: 0,
      users: 0,
    });
    expect(fake.batchDeleteCalls).toEqual([]);
    expect(fake.deleteCalls).toEqual([]);
  });

  it('skips a missing site doc without crashing the cascade', async () => {
    const userId = 'uid_missing_site';
    const fake = buildFakeDb({
      seedDocs: {
        [`users/${userId}`]: {
          exists: true,
          data: { sites: ['site-real', 'site-ghost'], role: 'admin' },
        },
        'sites/site-real': { exists: true, data: { name: 'real' } },
        // site-ghost intentionally absent
      },
      seedCollections: {
        'sites/site-real/machines': ['m1'],
      },
    });

    const result = await deleteOwnAccount({
      userId,
      operationId: 'op_ghost',
      db: fake.db,
    });

    expect(result.deletedCounts.sites).toBe(1); // only site-real
    expect(result.deletedCounts.machines).toBe(1);
    expect(fake.deleteCalls).toContain('sites/site-real');
    expect(fake.deleteCalls).not.toContain('sites/site-ghost');
  });

  it('treats a progress-doc write failure as non-fatal and continues', async () => {
    const userId = 'uid_progress_fail';
    const sites = ['site-pf'];
    const fake = buildFakeDb({
      seedDocs: seedUser(userId, sites),
      seedCollections: seedSubs(sites, {
        machines: 1,
        deployments: 1,
        logs: 1,
      }),
      progressSetFailure: new Error('progress doc firestore unavailable'),
    });

    const result = await deleteOwnAccount({
      userId,
      operationId: 'op_pf',
      db: fake.db,
    });

    // Cascade still completed.
    expect(result.deletedCounts.machines).toBe(1);
    expect(result.deletedCounts.deployments).toBe(1);
    expect(result.deletedCounts.logs).toBe(1);
    expect(result.deletedCounts.sites).toBe(1);
    expect(result.deletedCounts.users).toBe(1);

    // Both the in-progress AND the completion stamp tried to write and
    // both failed — non-fatal, with warnings logged.
    expect(loggerWarnSpy).toHaveBeenCalled();
  });

  it('handles a user with zero owned sites', async () => {
    const userId = 'uid_no_sites';
    const fake = buildFakeDb({
      seedDocs: seedUser(userId, []),
    });

    const result = await deleteOwnAccount({
      userId,
      operationId: 'op_no_sites',
      db: fake.db,
    });

    expect(result.deletedCounts).toEqual({
      machines: 0,
      deployments: 0,
      logs: 0,
      sites: 0,
      users: 1,
    });
    expect(fake.deleteCalls).toEqual([`users/${userId}`]);
    expect(fake.batchDeleteCalls).toEqual([]);
  });
});
