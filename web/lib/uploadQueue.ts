/**
 * Persistent, resumable upload queue (roost wave 3.3).
 *
 * Drag-drop a folder → the version builder (wave 3.2) enqueues one
 * upload task per chunk. The queue:
 *
 *   - persists pending + in-flight tasks to IndexedDB so closing the
 *     tab mid-upload doesn't lose progress
 *   - runs N tasks in parallel (default 4)
 *   - retries transient failures with exponential backoff + jitter
 *   - surfaces a progress callback on every state change
 *
 * Resume flow: caller reopens the dashboard and re-drops the same
 * folder; the hashing pass produces identical chunk hashes (CAS), the
 * queue looks up `state === 'succeeded'` entries already in the store
 * and skips them. Only in-flight / pending chunks replay.
 *
 * Storage is behind a `QueueStore` interface so Jest can exercise the
 * runner + retry arithmetic against an in-memory fake without adding
 * a fake-indexeddb dev dep.
 */

/* --------------------------------------------------------------------- */
/*  Types                                                                */
/* --------------------------------------------------------------------- */

export type TaskState = 'pending' | 'in_flight' | 'succeeded' | 'failed';

export interface UploadTask {
  /** Stable identity — typically the chunk hash so re-drops dedup. */
  id: string;
  state: TaskState;
  /** Retry attempts so far; 0 on first try. */
  attempt: number;
  /** Opaque payload the uploader needs (signed URL ref, chunk ref, etc.). */
  payload: unknown;
  /** Epoch ms of the last state change — for progress UI + TTL pruning. */
  updatedAt: number;
  /** Last error message if state === 'failed'. */
  error?: string;
  /** For progress bar — total bytes this task represents. */
  sizeBytes: number;
}

export interface QueueStore {
  get(id: string): Promise<UploadTask | undefined>;
  put(task: UploadTask): Promise<void>;
  /** List tasks by state. Pass `undefined` for "everything". */
  list(filter?: { state?: TaskState }): Promise<UploadTask[]>;
  delete(id: string): Promise<void>;
}

/* --------------------------------------------------------------------- */
/*  Retry arithmetic (pure)                                              */
/* --------------------------------------------------------------------- */

export interface BackoffOptions {
  /** First retry delay in ms. Default 1_000. */
  baseMs?: number;
  /** Multiplier per attempt. Default 2 (exponential). */
  factor?: number;
  /** Cap in ms so high attempts don't sleep forever. Default 30_000. */
  maxMs?: number;
  /** Jitter fraction [0,1]. Default 0.25 — ±25%. */
  jitter?: number;
  /** After this many attempts, give up. Default 6. */
  maxAttempts?: number;
}

/**
 * Compute the delay before retry-attempt `attempt` (1-indexed).
 * `attempt === 1` is the first retry after the initial attempt failed.
 *
 * `rng` is injectable for deterministic tests — pass a fixed value to
 * snapshot-test the backoff curve.
 */
export function nextRetryDelayMs(
  attempt: number,
  opts: BackoffOptions = {},
  rng: () => number = Math.random,
): number {
  const base = opts.baseMs ?? 1_000;
  const factor = opts.factor ?? 2;
  const max = opts.maxMs ?? 30_000;
  const jitter = opts.jitter ?? 0.25;

  if (attempt <= 0) return 0;

  const exponential = base * Math.pow(factor, attempt - 1);
  const capped = Math.min(exponential, max);
  // jitter: multiply by a factor in [1-jitter, 1+jitter]
  const jitterFactor = 1 + (rng() * 2 - 1) * jitter;
  return Math.max(0, Math.round(capped * jitterFactor));
}

/** True if `attempt` has exceeded the configured retry cap. */
export function shouldGiveUp(
  attempt: number,
  opts: BackoffOptions = {},
): boolean {
  const cap = opts.maxAttempts ?? 6;
  return attempt >= cap;
}

/* --------------------------------------------------------------------- */
/*  Pure queue operations                                                */
/* --------------------------------------------------------------------- */

/**
 * Given the full set of tasks, compute a progress snapshot for the UI.
 * Pure — no side effects, no storage reads outside the input.
 */
export function summariseQueue(tasks: readonly UploadTask[]): {
  total: number;
  succeeded: number;
  failed: number;
  pending: number;
  inFlight: number;
  bytesTotal: number;
  bytesSucceeded: number;
  settled: boolean;
} {
  let succeeded = 0;
  let failed = 0;
  let pending = 0;
  let inFlight = 0;
  let bytesTotal = 0;
  let bytesSucceeded = 0;
  for (const t of tasks) {
    bytesTotal += t.sizeBytes;
    switch (t.state) {
      case 'succeeded':
        succeeded++;
        bytesSucceeded += t.sizeBytes;
        break;
      case 'failed':
        failed++;
        break;
      case 'in_flight':
        inFlight++;
        break;
      case 'pending':
        pending++;
        break;
    }
  }
  return {
    total: tasks.length,
    succeeded,
    failed,
    pending,
    inFlight,
    bytesTotal,
    bytesSucceeded,
    settled: tasks.length > 0 && pending === 0 && inFlight === 0,
  };
}

/**
 * Decide which tasks should be launched given a concurrency budget and
 * the current in-flight count. Returns the IDs to move from `pending`
 * to `in_flight`, in stable order.
 */
export function selectNextBatch(
  pending: readonly UploadTask[],
  inFlightCount: number,
  concurrency: number,
): UploadTask[] {
  const slots = Math.max(0, concurrency - inFlightCount);
  if (slots === 0) return [];
  // stable slice — callers rely on FIFO ordering for predictable progress.
  return pending.slice(0, slots);
}

/* --------------------------------------------------------------------- */
/*  Runner                                                               */
/* --------------------------------------------------------------------- */

/** The work function the caller supplies — does the actual HTTP PUT. */
export type UploadFn = (task: UploadTask) => Promise<void>;

export interface RunnerOptions {
  concurrency?: number;
  backoff?: BackoffOptions;
  onProgress?: (snapshot: ReturnType<typeof summariseQueue>) => void;
  signal?: AbortSignal;
  /** Injectable for tests — real code uses globalThis.setTimeout. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable for tests — real code uses Date.now. */
  now?: () => number;
}

export interface RunResult {
  succeeded: number;
  failed: number;
  aborted: boolean;
}

/**
 * Drive the queue to completion (or abort). Respects concurrency; retries
 * transient failures with backoff; writes every state transition back to
 * the store so tab-close recovery is automatic.
 *
 * Returns when every task is terminal (succeeded | failed + max attempts)
 * or the abort signal fires.
 */
export async function runUploadQueue(
  store: QueueStore,
  upload: UploadFn,
  opts: RunnerOptions = {},
): Promise<RunResult> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const backoff = opts.backoff ?? {};
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;

  // on start: any task we find in `in_flight` is a zombie from a previous
  // tab (crash or close). demote to pending so the backoff arithmetic
  // restarts cleanly.
  for (const zombie of await store.list({ state: 'in_flight' })) {
    await store.put({ ...zombie, state: 'pending', updatedAt: now() });
  }

  const inFlight = new Set<string>();

  const snapshot = async () => summariseQueue(await store.list());
  const notifyProgress = async () => {
    if (opts.onProgress) opts.onProgress(await snapshot());
  };

  await notifyProgress();

  while (true) {
    if (opts.signal?.aborted) {
      return { succeeded: 0, failed: 0, aborted: true };
    }

    const pending = await store.list({ state: 'pending' });
    // never terminal: wait for in-flight to finish before declaring done.
    if (pending.length === 0 && inFlight.size === 0) break;

    const launch = selectNextBatch(pending, inFlight.size, concurrency);
    if (launch.length === 0) {
      // waiting for in-flight — yield. the then() chain on each promise
      // will loop back in and pick up the next pending batch.
      await sleep(10, opts.signal);
      continue;
    }

    for (const task of launch) {
      const started: UploadTask = {
        ...task,
        state: 'in_flight',
        updatedAt: now(),
      };
      await store.put(started);
      inFlight.add(task.id);
      // fire-and-register; don't await here so parallelism is actually parallel.
      void (async () => {
        try {
          await upload(started);
          await store.put({ ...started, state: 'succeeded', updatedAt: now() });
        } catch (err) {
          const nextAttempt = started.attempt + 1;
          const message = err instanceof Error ? err.message : String(err);
          if (shouldGiveUp(nextAttempt, backoff)) {
            await store.put({
              ...started,
              state: 'failed',
              attempt: nextAttempt,
              updatedAt: now(),
              error: message,
            });
          } else {
            // back off then requeue as pending. the sleep is here (not
            // inside the main loop) so other tasks aren't blocked while
            // this one waits.
            const delay = nextRetryDelayMs(nextAttempt, backoff);
            try {
              await sleep(delay, opts.signal);
            } catch {
              /* aborted during backoff — drop through */
            }
            await store.put({
              ...started,
              state: 'pending',
              attempt: nextAttempt,
              updatedAt: now(),
              error: message,
            });
          }
        } finally {
          inFlight.delete(task.id);
          await notifyProgress();
        }
      })();
    }

    await notifyProgress();
    // give the event loop a chance to execute the fire-and-register tasks
    await sleep(0, opts.signal);
  }

  const final = await snapshot();
  return {
    succeeded: final.succeeded,
    failed: final.failed,
    aborted: false,
  };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError());
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(makeAbortError());
      },
      { once: true },
    );
  });
}

function makeAbortError(): Error {
  const E =
    typeof DOMException !== 'undefined'
      ? new DOMException('aborted', 'AbortError')
      : Object.assign(new Error('aborted'), { name: 'AbortError' });
  return E as Error;
}

/* --------------------------------------------------------------------- */
/*  IndexedDB-backed QueueStore — see ./uploadQueue.idb.ts                */
/* --------------------------------------------------------------------- */

// The browser IndexedDB adapter lives in a separate file so this module
// can stay fully unit-testable under Node. The adapter is thin — it only
// satisfies the `QueueStore` interface with `indexedDB.open` + tx plumbing
// — and its correctness depends on real IndexedDB semantics, which a fake
// would only mirror by definition. Left out of unit tests on purpose; an
// integration test with a real browser (or fake-indexeddb, if we ever
// allow that dep) belongs to the wave 1.6 test-infra task.
export { openIndexedDBStore } from './uploadQueue.idb';
