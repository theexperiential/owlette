/**
 * Persistent, resumable upload queue (roost wave 3.3).
 *
 * One task per chunk, persisted to IndexedDB so closing the tab mid-upload
 * doesn't lose progress; N in parallel (default 4); exponential backoff +
 * jitter on transient failures; progress callback on every state change.
 *
 * Resume: re-dropping the same folder produces identical chunk hashes (CAS),
 * so `succeeded` entries already in the store are skipped.
 *
 * Storage sits behind `QueueStore` so Jest can exercise the runner and retry
 * arithmetic without a fake-indexeddb dev dep.
 */

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
 * Delay before retry-attempt `attempt` (1-indexed; 1 = first retry after the
 * initial attempt failed). `rng` is injectable for deterministic tests.
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

/** Progress snapshot for the UI. Pure — reads nothing outside its input. */
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

/** Pending tasks to promote to in_flight given the concurrency budget. */
export function selectNextBatch(
  pending: readonly UploadTask[],
  inFlightCount: number,
  concurrency: number,
): UploadTask[] {
  const slots = Math.max(0, concurrency - inFlightCount);
  if (slots === 0) return [];
  // Stable slice — callers rely on FIFO for predictable progress.
  return pending.slice(0, slots);
}

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
 * Drive the queue to completion (or abort). Every state transition is written
 * back to the store, so tab-close recovery is automatic. Returns once all tasks
 * are terminal (succeeded, or failed at max attempts) or the signal fires.
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

  // Any `in_flight` task at startup is a zombie from a crashed/closed tab —
  // demote to pending so the backoff arithmetic restarts cleanly.
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
    // Not terminal until in-flight work drains too.
    if (pending.length === 0 && inFlight.size === 0) break;

    const launch = selectNextBatch(pending, inFlight.size, concurrency);
    if (launch.length === 0) {
      // All slots busy — yield; the loop picks up the next batch.
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
      // Don't await — parallelism depends on it.
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
            // Sleep here rather than in the main loop so other tasks aren't
            // blocked while this one backs off.
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
    // Let the event loop run the fire-and-register tasks.
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

// The IndexedDB adapter lives in a separate file so this module stays
// unit-testable under Node. Its correctness depends on real IndexedDB semantics
// that a fake would only mirror by definition — intentionally not unit-tested;
// an integration test belongs to the wave 1.6 test-infra task.
export { openIndexedDBStore } from './uploadQueue.idb';
