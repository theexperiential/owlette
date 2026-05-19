/**
 * @jest-environment node
 *
 * tests for web/lib/uploadQueue.ts (roost wave 3.3).
 *
 * Store interface is injected — exercises the runner + retry arithmetic
 * against an in-memory fake. No IndexedDB emulator dep.
 */

import {
  nextRetryDelayMs,
  runUploadQueue,
  selectNextBatch,
  shouldGiveUp,
  summariseQueue,
  type QueueStore,
  type UploadFn,
  type UploadTask,
} from '@/lib/uploadQueue';

/* --------------------------------------------------------------------- */
/*  In-memory QueueStore                                                 */
/* --------------------------------------------------------------------- */

function memoryStore(initial: UploadTask[] = []): QueueStore & {
  snapshot(): UploadTask[];
} {
  const map = new Map<string, UploadTask>();
  for (const t of initial) map.set(t.id, t);
  return {
    async get(id) { return map.get(id); },
    async put(task) { map.set(task.id, { ...task }); },
    async list(filter) {
      const arr = [...map.values()];
      if (filter?.state) return arr.filter((t) => t.state === filter.state);
      return arr;
    },
    async delete(id) { map.delete(id); },
    snapshot() { return [...map.values()]; },
  };
}

function mkTask(id: string, size = 4 * 1024 * 1024): UploadTask {
  return {
    id,
    state: 'pending',
    attempt: 0,
    payload: { id },
    updatedAt: 0,
    sizeBytes: size,
  };
}

/* --------------------------------------------------------------------- */
/*  nextRetryDelayMs                                                     */
/* --------------------------------------------------------------------- */

describe('nextRetryDelayMs', () => {
  it('attempt 1 → baseMs (± jitter zero when rng=0.5)', () => {
    // rng=0.5 → jitterFactor = 1 → no randomness
    expect(nextRetryDelayMs(1, { baseMs: 1_000, jitter: 0.25 }, () => 0.5)).toBe(1_000);
  });

  it('exponential growth across attempts', () => {
    const rng = () => 0.5; // suppress jitter
    expect(nextRetryDelayMs(1, { baseMs: 1_000, factor: 2 }, rng)).toBe(1_000);
    expect(nextRetryDelayMs(2, { baseMs: 1_000, factor: 2 }, rng)).toBe(2_000);
    expect(nextRetryDelayMs(3, { baseMs: 1_000, factor: 2 }, rng)).toBe(4_000);
    expect(nextRetryDelayMs(4, { baseMs: 1_000, factor: 2 }, rng)).toBe(8_000);
  });

  it('caps at maxMs', () => {
    const rng = () => 0.5;
    const d = nextRetryDelayMs(
      10,
      { baseMs: 1_000, factor: 2, maxMs: 30_000 },
      rng,
    );
    expect(d).toBe(30_000);
  });

  it('applies jitter in [-jitter, +jitter] fraction of capped delay', () => {
    // rng=0 → jitterFactor = 1 - 0.25 = 0.75 → 750 for base 1000
    // rng=1 → jitterFactor = 1 + 0.25 = 1.25 → 1250 for base 1000
    expect(
      nextRetryDelayMs(1, { baseMs: 1_000, jitter: 0.25 }, () => 0),
    ).toBe(750);
    expect(
      nextRetryDelayMs(1, { baseMs: 1_000, jitter: 0.25 }, () => 1),
    ).toBe(1_250);
  });

  it('attempt ≤ 0 → 0 (no retry scheduled)', () => {
    expect(nextRetryDelayMs(0)).toBe(0);
    expect(nextRetryDelayMs(-1)).toBe(0);
  });
});

describe('shouldGiveUp', () => {
  it('false while under cap', () => {
    expect(shouldGiveUp(1, { maxAttempts: 6 })).toBe(false);
    expect(shouldGiveUp(5, { maxAttempts: 6 })).toBe(false);
  });
  it('true at and beyond the cap', () => {
    expect(shouldGiveUp(6, { maxAttempts: 6 })).toBe(true);
    expect(shouldGiveUp(100, { maxAttempts: 6 })).toBe(true);
  });
  it('defaults cap at 6', () => {
    expect(shouldGiveUp(6)).toBe(true);
  });
});

/* --------------------------------------------------------------------- */
/*  summariseQueue + selectNextBatch                                     */
/* --------------------------------------------------------------------- */

describe('summariseQueue', () => {
  it('reports settled when nothing is pending or in-flight', () => {
    const s = summariseQueue([
      { ...mkTask('a'), state: 'succeeded' },
      { ...mkTask('b'), state: 'failed' },
    ]);
    expect(s.settled).toBe(true);
    expect(s.succeeded).toBe(1);
    expect(s.failed).toBe(1);
  });

  it('reports not-settled with pending or in-flight', () => {
    const s = summariseQueue([
      { ...mkTask('a'), state: 'succeeded' },
      { ...mkTask('b'), state: 'pending' },
    ]);
    expect(s.settled).toBe(false);
  });

  it('sums bytes correctly', () => {
    const s = summariseQueue([
      { ...mkTask('a', 100), state: 'succeeded' },
      { ...mkTask('b', 200), state: 'pending' },
    ]);
    expect(s.bytesTotal).toBe(300);
    expect(s.bytesSucceeded).toBe(100);
  });
});

describe('selectNextBatch', () => {
  it('respects concurrency', () => {
    const pending = [mkTask('a'), mkTask('b'), mkTask('c'), mkTask('d')];
    const picked = selectNextBatch(pending, 0, 2);
    expect(picked.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('returns empty when at capacity', () => {
    const pending = [mkTask('a')];
    expect(selectNextBatch(pending, 4, 4)).toEqual([]);
  });

  it('partial slots when some in-flight', () => {
    const pending = [mkTask('a'), mkTask('b'), mkTask('c'), mkTask('d')];
    const picked = selectNextBatch(pending, 2, 4);
    expect(picked.length).toBe(2);
  });
});

/* --------------------------------------------------------------------- */
/*  runUploadQueue                                                       */
/* --------------------------------------------------------------------- */

/** Silent, instant sleep for tests. Honours abort. */
function fastSleep(_ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    setImmediate(resolve);
  });
}

describe('runUploadQueue', () => {
  it('runs an empty queue to completion immediately', async () => {
    const store = memoryStore();
    const upload: UploadFn = async () => {};
    const res = await runUploadQueue(store, upload, {
      sleep: fastSleep,
    });
    expect(res).toEqual({ succeeded: 0, failed: 0, aborted: false });
  });

  it('uploads every pending task exactly once on the happy path', async () => {
    const store = memoryStore([
      mkTask('a'),
      mkTask('b'),
      mkTask('c'),
      mkTask('d'),
      mkTask('e'),
    ]);
    const called: string[] = [];
    const upload: UploadFn = async (task) => {
      called.push(task.id);
    };
    const res = await runUploadQueue(store, upload, {
      concurrency: 2,
      sleep: fastSleep,
    });
    expect(res.succeeded).toBe(5);
    expect(res.failed).toBe(0);
    expect(new Set(called)).toEqual(new Set(['a', 'b', 'c', 'd', 'e']));
    for (const t of store.snapshot()) expect(t.state).toBe('succeeded');
  });

  it('retries transient failures up to cap, then marks failed', async () => {
    const store = memoryStore([mkTask('flaky')]);
    let attempts = 0;
    const upload: UploadFn = async () => {
      attempts++;
      throw new Error('transient');
    };
    const res = await runUploadQueue(store, upload, {
      concurrency: 1,
      backoff: { baseMs: 0, maxMs: 0, jitter: 0, maxAttempts: 3 },
      sleep: fastSleep,
    });
    expect(res.failed).toBe(1);
    // 1 initial + 2 retries = 3 attempts before giving up (nextAttempt hits cap)
    expect(attempts).toBe(3);
    const final = await store.get('flaky');
    expect(final?.state).toBe('failed');
    expect(final?.attempt).toBe(3);
    expect(final?.error).toBe('transient');
  });

  it('retries then succeeds on later attempt', async () => {
    const store = memoryStore([mkTask('recover')]);
    let attempts = 0;
    const upload: UploadFn = async () => {
      attempts++;
      if (attempts < 3) throw new Error('blip');
    };
    await runUploadQueue(store, upload, {
      concurrency: 1,
      backoff: { baseMs: 0, maxMs: 0, jitter: 0, maxAttempts: 6 },
      sleep: fastSleep,
    });
    const final = await store.get('recover');
    expect(final?.state).toBe('succeeded');
    expect(final?.attempt).toBe(2); // 2 retries before the success on attempt 3
  });

  it('resumes from persistence — already-succeeded tasks are NOT re-uploaded', async () => {
    // this is the regression that proves tab-close recovery: a succeeded
    // task in the store means the runner skips it on the next run.
    const store = memoryStore([
      { ...mkTask('done-before-tab-close'), state: 'succeeded' },
      mkTask('still-to-upload'),
    ]);
    const called: string[] = [];
    const upload: UploadFn = async (task) => {
      called.push(task.id);
    };
    await runUploadQueue(store, upload, {
      concurrency: 1,
      sleep: fastSleep,
    });
    expect(called).toEqual(['still-to-upload']);
  });

  it('demotes `in_flight` zombies from a crashed prior tab to `pending`', async () => {
    // on start, an in-flight task is assumed to be a zombie from a tab
    // that crashed before the upload completed. it must be re-run, not
    // left stranded.
    const zombie: UploadTask = {
      ...mkTask('zombie'),
      state: 'in_flight',
      attempt: 1,
    };
    const store = memoryStore([zombie]);
    const called: string[] = [];
    const upload: UploadFn = async (t) => { called.push(t.id); };
    await runUploadQueue(store, upload, {
      concurrency: 1,
      sleep: fastSleep,
    });
    expect(called).toEqual(['zombie']);
    const final = await store.get('zombie');
    expect(final?.state).toBe('succeeded');
  });

  it('respects concurrency — no more than N tasks in-flight at once', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const store = memoryStore(ids.map((id) => mkTask(id)));
    let currentlyRunning = 0;
    let peak = 0;
    const upload: UploadFn = async () => {
      currentlyRunning++;
      peak = Math.max(peak, currentlyRunning);
      await new Promise((r) => setImmediate(r));
      currentlyRunning--;
    };
    await runUploadQueue(store, upload, {
      concurrency: 3,
      sleep: fastSleep,
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('emits progress updates on state changes', async () => {
    const store = memoryStore([mkTask('a', 100), mkTask('b', 200)]);
    const upload: UploadFn = async () => {};
    const progressSnapshots: Array<{
      succeeded: number;
      bytesSucceeded: number;
    }> = [];
    await runUploadQueue(store, upload, {
      concurrency: 1,
      sleep: fastSleep,
      onProgress: (s) => {
        progressSnapshots.push({
          succeeded: s.succeeded,
          bytesSucceeded: s.bytesSucceeded,
        });
      },
    });
    // at least one snapshot per state transition
    expect(progressSnapshots.length).toBeGreaterThanOrEqual(2);
    // monotonic
    for (let i = 1; i < progressSnapshots.length; i++) {
      expect(progressSnapshots[i].bytesSucceeded).toBeGreaterThanOrEqual(
        progressSnapshots[i - 1].bytesSucceeded,
      );
    }
    // final snapshot shows everything succeeded
    const last = progressSnapshots[progressSnapshots.length - 1];
    expect(last.bytesSucceeded).toBe(300);
  });

  it('honours AbortSignal — returns aborted before new tasks start', async () => {
    const controller = new AbortController();
    // pre-abort so the runner exits on its first loop iteration.
    controller.abort();
    const store = memoryStore([mkTask('a')]);
    const upload: UploadFn = async () => {};
    const res = await runUploadQueue(store, upload, {
      concurrency: 1,
      signal: controller.signal,
      sleep: fastSleep,
    });
    expect(res.aborted).toBe(true);
  });
});
