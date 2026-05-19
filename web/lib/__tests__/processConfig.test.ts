/** @jest-environment node */

/**
 * Unit tests for `withProcessLock`, `readProcessList`, and `findProcessIndex`.
 *
 * Covers:
 * - happy path read-modify-write
 * - duplicate-name rejection inside the transaction
 * - lazy backfill of `processId` for legacy rows missing it
 * - concurrent-update isolation (the mutator sees the transaction-fresh view,
 *   not a stale snapshot — verified by simulating a contended retry)
 * - missing-config 404
 * - findProcessIndex semantics
 */

// Mock firebase-admin BEFORE any imports of processConfig.server.
const mockGet = jest.fn();
const mockUpdate = jest.fn().mockResolvedValue(undefined);

// runTransaction simulator — tracks the most recent "stored" processes array
// and re-runs the txn body up to N times if the simulator decides to inject a
// retry (mirrors Firestore's optimistic-concurrency retry on contention).
// Backing store: the "stored data" is just an object; storedDoc.data()
// returns a fresh shallow clone so reads don't share references with writes.
let storedData: Record<string, unknown> | null = null;
let storedExists = false;
let injectedRetries = 0; // how many txn attempts to fail-and-retry before committing

function makeDocSnapshot() {
  return {
    exists: storedExists,
    data: () => (storedExists && storedData ? { ...storedData } : undefined),
  };
}

// FIFO mutex so concurrent runTransaction calls serialize like real Firestore.
let txnQueue: Promise<unknown> = Promise.resolve();

const runTransaction = jest.fn((fn: (txn: unknown) => Promise<unknown>) => {
  const next = txnQueue.then(async () => {
    let attempts = 0;
    while (true) {
      attempts++;
      let pendingPatch: Record<string, unknown> | null = null;
      const txn = {
        get: jest.fn().mockImplementation(async () => makeDocSnapshot()),
        update: jest.fn((_ref: unknown, patch: Record<string, unknown>) => {
          // Defer the write until the txn body completes — this matches
          // Firestore's commit semantics and lets us inject a "lost commit".
          pendingPatch = patch;
        }),
      };
      const result = await fn(txn);
      if (injectedRetries > 0 && attempts < 5) {
        injectedRetries--;
        // Pretend the commit was lost; loop and retry without applying patch.
        continue;
      }
      if (pendingPatch && Array.isArray((pendingPatch as { processes?: unknown }).processes)) {
        storedData = { ...(storedData || {}), ...(pendingPatch as Record<string, unknown>) };
        storedExists = true;
      }
      return result;
    }
  });
  // Re-arm the queue without propagating rejections (so a failed txn doesn't
  // poison subsequent ones).
  txnQueue = next.catch(() => undefined);
  return next;
});

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: () => ({
      doc: () => ({
        get: mockGet,
        update: mockUpdate,
        collection: () => ({
          doc: () => ({
            get: mockGet,
            update: mockUpdate,
          }),
        }),
      }),
    }),
    runTransaction: (fn: (txn: unknown) => Promise<unknown>) => runTransaction(fn),
  }),
}));

import {
  withProcessLock,
  readProcessList,
  findProcessIndex,
  generateProcessId,
  ProcessConfigError,
  PublicProcessConfig,
} from '@/lib/processConfig.server';

function setStored(data: Record<string, unknown> | null): void {
  storedData = data;
  storedExists = data !== null;
}

function getFinalProcesses(): unknown[] {
  return Array.isArray(storedData?.processes) ? (storedData!.processes as unknown[]) : [];
}

function makeProc(overrides: Partial<PublicProcessConfig> = {}): PublicProcessConfig {
  const id = overrides.processId || overrides.id || 'proc-uuid-1';
  return {
    id,
    processId: id,
    name: 'TestProc',
    exe_path: 'C:/test.exe',
    file_path: '',
    cwd: '',
    priority: 'Normal',
    visibility: 'Show',
    time_delay: '0',
    time_to_init: '10',
    relaunch_attempts: '3',
    autolaunch: false,
    launch_mode: 'off',
    schedules: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  injectedRetries = 0;
  storedData = null;
  storedExists = false;
  txnQueue = Promise.resolve();
});

describe('withProcessLock', () => {
  it('throws 404 if config doc does not exist', async () => {
    setStored(null);
    await expect(
      withProcessLock('s1', 'm1', (p) => ({ processes: p, result: undefined }))
    ).rejects.toBeInstanceOf(ProcessConfigError);
  });

  it('runs the mutator with the current array and writes back', async () => {
    setStored({ processes: [makeProc({ processId: 'a', name: 'A' })] });

    const result = await withProcessLock<string>('s1', 'm1', (procs) => {
      expect(procs).toHaveLength(1);
      expect(procs[0].processId).toBe('a');
      const next = [...procs, makeProc({ processId: 'b', name: 'B' })];
      return { processes: next, result: 'created-b' };
    });

    expect(result).toBe('created-b');
    expect(getFinalProcesses()).toHaveLength(2);
  });

  it('rejects duplicate name with code duplicate_process_name', async () => {
    setStored({ processes: [makeProc({ processId: 'a', name: 'Same' })] });

    await expect(
      withProcessLock('s1', 'm1', (procs) => {
        const next = [...procs, makeProc({ processId: 'b', name: 'Same' })];
        return { processes: next, result: undefined };
      })
    ).rejects.toMatchObject({ status: 409, code: 'duplicate_process_name' });
  });

  it('rejects duplicate name even if both rows are pre-existing (race-safe)', async () => {
    setStored({
      processes: [
        makeProc({ processId: 'a', name: 'Dup' }),
        makeProc({ processId: 'b', name: 'Dup' }),
      ],
    });

    await expect(
      withProcessLock('s1', 'm1', (procs) => ({ processes: procs, result: undefined }))
    ).rejects.toMatchObject({ status: 409, code: 'duplicate_process_name' });
  });

  it('lazily backfills processId for legacy rows missing it', async () => {
    setStored({
      processes: [{ id: 'legacy-1', name: 'Legacy', exe_path: 'C:/x.exe', launch_mode: 'off' }],
    });

    let observed: PublicProcessConfig[] = [];
    await withProcessLock('s1', 'm1', (procs) => {
      observed = procs;
      return { processes: procs, result: undefined };
    });

    expect(observed[0].processId).toBe('legacy-1');
    expect(observed[0].id).toBe('legacy-1');
  });

  it('generates a fresh processId for legacy rows missing both id and processId', async () => {
    setStored({
      processes: [{ name: 'NoId', exe_path: 'C:/x.exe', launch_mode: 'off' }],
    });

    let observed: PublicProcessConfig[] = [];
    await withProcessLock('s1', 'm1', (procs) => {
      observed = procs;
      return { processes: procs, result: undefined };
    });

    expect(observed[0].processId).toBeTruthy();
    expect(observed[0].id).toBe(observed[0].processId);
  });

  it('survives an injected retry without losing data (concurrent-update isolation)', async () => {
    setStored({ processes: [makeProc({ processId: 'a', name: 'A' })] });

    // First commit will be retried; the second should see the (re-read) state.
    injectedRetries = 1;

    let attemptCount = 0;
    await withProcessLock('s1', 'm1', (procs) => {
      attemptCount++;
      const next = [...procs, makeProc({ processId: 'b', name: 'B' })];
      return { processes: next, result: undefined };
    });

    // Mutator re-runs on retry; final state has exactly 2 rows (no double-append).
    expect(attemptCount).toBeGreaterThan(1);
    expect(getFinalProcesses()).toHaveLength(2);
  });

  it('serializes truly concurrent calls (each sees the prior write)', async () => {
    setStored({ processes: [] as PublicProcessConfig[] });

    // Fire two concurrent appends. Even though we await sequentially in the
    // test, the runTransaction mock is itself a single-flight FIFO, so each
    // call sees the data committed by the prior one.
    const p1 = withProcessLock('s1', 'm1', (procs) => ({
      processes: [...procs, makeProc({ processId: 'one', name: 'One' })],
      result: 'one',
    }));
    const p2 = withProcessLock('s1', 'm1', (procs) => ({
      processes: [...procs, makeProc({ processId: 'two', name: 'Two' })],
      result: 'two',
    }));
    await Promise.all([p1, p2]);

    const final = getFinalProcesses() as PublicProcessConfig[];
    expect(final).toHaveLength(2);
    const names = final.map((p) => p.name).sort();
    expect(names).toEqual(['One', 'Two']);
  });

  it('refuses to commit when the mutator returns the same name as an existing row', async () => {
    setStored({ processes: [makeProc({ processId: 'a', name: 'Existing' })] });

    await expect(
      withProcessLock('s1', 'm1', (procs) => ({
        processes: [...procs, makeProc({ processId: 'b', name: 'Existing' })],
        result: undefined,
      }))
    ).rejects.toMatchObject({ status: 409, code: 'duplicate_process_name' });
  });

  it('preserves processId stability across update', async () => {
    setStored({ processes: [makeProc({ processId: 'p1', name: 'A', exe_path: 'C:/old.exe' })] });

    await withProcessLock('s1', 'm1', (procs) => {
      const next = procs.map((p) =>
        p.processId === 'p1' ? { ...p, exe_path: 'C:/new.exe' } : p
      );
      return { processes: next, result: undefined };
    });

    const final = getFinalProcesses() as PublicProcessConfig[];
    expect(final[0].processId).toBe('p1');
    expect(final[0].exe_path).toBe('C:/new.exe');
  });
});

describe('readProcessList', () => {
  it('returns null if config doc does not exist', async () => {
    mockGet.mockResolvedValueOnce({ exists: false, data: () => null });
    const out = await readProcessList('s1', 'm1');
    expect(out).toBeNull();
  });

  it('returns empty array if processes field is missing', async () => {
    mockGet.mockResolvedValueOnce({ exists: true, data: () => ({}) });
    const out = await readProcessList('s1', 'm1');
    expect(out).toEqual([]);
  });

  it('lazily backfills processId for legacy rows', async () => {
    mockGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        processes: [{ id: 'legacy-1', name: 'X', exe_path: '', launch_mode: 'off' }],
      }),
    });
    const out = await readProcessList('s1', 'm1');
    expect(out![0].processId).toBe('legacy-1');
  });

  it('returns processes already having processId untouched', async () => {
    mockGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        processes: [
          { id: 'p1', processId: 'p1', name: 'X', exe_path: '', launch_mode: 'off' },
          { id: 'p2', processId: 'p2', name: 'Y', exe_path: '', launch_mode: 'off' },
        ],
      }),
    });
    const out = await readProcessList('s1', 'm1');
    expect(out).toHaveLength(2);
    expect(out![0].processId).toBe('p1');
    expect(out![1].processId).toBe('p2');
  });
});

describe('findProcessIndex', () => {
  it('finds by processId', () => {
    const procs = [
      makeProc({ processId: 'a' }),
      makeProc({ processId: 'b' }),
      makeProc({ processId: 'c' }),
    ];
    expect(findProcessIndex(procs, 'b')).toBe(1);
  });

  it('returns -1 for unknown id', () => {
    const procs = [makeProc({ processId: 'a' })];
    expect(findProcessIndex(procs, 'missing')).toBe(-1);
  });

  it('does not match by name (only processId)', () => {
    const procs = [makeProc({ processId: 'a', name: 'TestProc' })];
    expect(findProcessIndex(procs, 'TestProc')).toBe(-1);
  });
});

describe('generateProcessId', () => {
  it('produces a uuid string', () => {
    const id = generateProcessId();
    expect(typeof id).toBe('string');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('produces unique ids on repeated calls', () => {
    const a = generateProcessId();
    const b = generateProcessId();
    expect(a).not.toBe(b);
  });
});
