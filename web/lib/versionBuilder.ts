/**
 * Client-side wrapper for the off-main-thread version builder worker
 * (roost wave 3.2).
 *
 * Spawns the worker defined in `workers/versionBuilder.worker.ts`,
 * forwards File objects via transferable-friendly messages, and returns
 * a promise that resolves with the finished version entries. Progress
 * events stream via an optional callback.
 *
 * **Why a worker at all**: hashing a 100 GB folder in ~25,000 × 4 MiB
 * chunks keeps the CPU + IO pipeline busy for tens of seconds. Running
 * it on the main thread would freeze the dashboard. The worker keeps
 * the UI responsive; the main thread just displays progress ticks.
 *
 * The pure chunking logic lives in `./chunking.ts` — this file is the
 * message-protocol glue. Both halves import the same types so the wire
 * format is statically validated.
 */

import type {
  VersionFileEntry,
  VersionProgress,
  NamedBlob,
} from './chunking';

/* --------------------------------------------------------------------- */
/*  Wire protocol                                                        */
/* --------------------------------------------------------------------- */

export type WorkerInbound =
  | { type: 'start'; files: NamedBlob[] }
  | { type: 'abort' };

export type WorkerOutbound =
  | { type: 'progress'; progress: VersionProgress }
  | { type: 'done'; entries: VersionFileEntry[] }
  | { type: 'error'; message: string; name?: string };

/* --------------------------------------------------------------------- */
/*  Public API                                                           */
/* --------------------------------------------------------------------- */

export interface BuildOptions {
  onProgress?: (p: VersionProgress) => void;
  signal?: AbortSignal;
  /**
   * Injectable Worker factory — lets tests swap in a fake without
   * bundler-specific `new Worker(new URL(...))` syntax.
   */
  workerFactory?: () => WorkerLike;
}

/** Minimal Worker shape we rely on. */
export interface WorkerLike {
  postMessage(msg: WorkerInbound): void;
  addEventListener(
    type: 'message',
    listener: (ev: { data: WorkerOutbound }) => void,
  ): void;
  addEventListener(type: 'error', listener: (ev: ErrorEvent) => void): void;
  terminate(): void;
}

/**
 * Build a version for the supplied files, off-main-thread.
 *
 * Resolves with the ordered list of `VersionFileEntry` once every file
 * is hashed. Rejects on worker error or abort. The worker is terminated
 * on resolve, reject, or abort — no lingering threads.
 */
export async function buildVersion(
  files: readonly NamedBlob[],
  opts: BuildOptions = {},
): Promise<VersionFileEntry[]> {
  // Env without Worker (Jest/Node unit tests, SSR snapshots, etc.) falls
  // back to the sync in-process path so behaviour is correct everywhere.
  // Browser prod always has Worker, so this branch doesn't cost real users
  // anything.
  if (!opts.workerFactory && typeof Worker === 'undefined') {
    const { buildVersionEntries } = await import('./chunking');
    return buildVersionEntries(files, {
      signal: opts.signal,
      onProgress: opts.onProgress,
    });
  }

  // Multi-worker fan-out for multi-file uploads. A single worker is
  // sequential across files, so a 3-file × 4.9 GB upload pipelines only
  // one file at a time. Splitting across N workers — where N is capped
  // by file count and CPU cores — lets independent files hash in
  // parallel. For the typical media-asset workload (a handful of large
  // .orbx / .toe files) this yields near-linear speedup up to file count.
  const hardwareConcurrency =
    typeof navigator !== 'undefined' && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4;
  // Cap workers: one per file (no benefit beyond), and at most 4 to
  // avoid thrashing (SHA-NI + disk bandwidth saturate before CPU count).
  const workerCount = Math.min(files.length, hardwareConcurrency, 4);
  if (workerCount <= 1) {
    return runSingleWorker(files, opts);
  }
  return runMultiWorker(files, workerCount, opts);
}

/** Single-worker path — preserved behaviour for 0/1-file uploads. */
function runSingleWorker(
  files: readonly NamedBlob[],
  opts: BuildOptions,
): Promise<VersionFileEntry[]> {
  return new Promise<VersionFileEntry[]>((resolve, reject) => {
    const worker = (opts.workerFactory ?? defaultWorkerFactory)();
    let done = false;

    const cleanup = () => {
      if (done) return;
      done = true;
      worker.terminate();
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      worker.postMessage({ type: 'abort' });
      cleanup();
      reject(makeAbortError());
    };

    if (opts.signal) {
      if (opts.signal.aborted) {
        worker.terminate();
        reject(makeAbortError());
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    worker.addEventListener('message', (ev) => {
      const msg = ev.data;
      switch (msg.type) {
        case 'progress':
          opts.onProgress?.(msg.progress);
          break;
        case 'done':
          cleanup();
          resolve(msg.entries);
          break;
        case 'error':
          cleanup();
          reject(Object.assign(new Error(msg.message), { name: msg.name ?? 'Error' }));
          break;
      }
    });

    worker.addEventListener('error', (ev) => {
      cleanup();
      reject(new Error(ev.message || 'worker error'));
    });

    worker.postMessage({ type: 'start', files: [...files] });
  });
}

/**
 * Partition files across `workerCount` workers using largest-first
 * balanced bin-packing (greedy: put the biggest file in the bin with
 * the smallest current load). For heterogeneous file sizes this keeps
 * the slowest worker from dominating total wall time.
 */
function partitionFiles(
  files: readonly NamedBlob[],
  workerCount: number,
): NamedBlob[][] {
  const bins: { files: NamedBlob[]; bytes: number }[] = Array.from(
    { length: workerCount },
    () => ({ files: [], bytes: 0 }),
  );
  const sorted = [...files].sort((a, b) => b.blob.size - a.blob.size);
  for (const f of sorted) {
    let lightest = bins[0];
    for (const bin of bins) if (bin.bytes < lightest.bytes) lightest = bin;
    lightest.files.push(f);
    lightest.bytes += f.blob.size;
  }
  return bins.map((b) => b.files).filter((b) => b.length > 0);
}

/**
 * Multi-worker path — each worker gets a disjoint subset of the files,
 * runs the same sequential pipeline internally. Entries are reassembled
 * in the caller's original file order; progress is aggregated to a
 * single global view so the UI still sees a monotonic bar.
 */
function runMultiWorker(
  files: readonly NamedBlob[],
  workerCount: number,
  opts: BuildOptions,
): Promise<VersionFileEntry[]> {
  const partitions = partitionFiles(files, workerCount);
  const totalBytes = files.reduce((n, f) => n + f.blob.size, 0);
  const totalFiles = files.length;
  // Per-worker progress state; aggregation sums these.
  const perWorkerBytes: number[] = partitions.map(() => 0);
  const perWorkerCompleted: number[] = partitions.map(() => 0);
  // Collection: results indexed by worker, then merged back to original
  // file order by matching `path`.
  const pathIndex = new Map<string, number>();
  files.forEach((f, i) => pathIndex.set(f.path, i));
  const ordered: (VersionFileEntry | undefined)[] = new Array(files.length);

  return new Promise<VersionFileEntry[]>((resolve, reject) => {
    const workers: WorkerLike[] = partitions.map(
      () => (opts.workerFactory ?? defaultWorkerFactory)(),
    );
    let settled = false;
    let remaining = workers.length;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      for (const w of workers) {
        try {
          w.terminate();
        } catch {
          // ignore — already terminated
        }
      }
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      for (const w of workers) {
        try {
          w.postMessage({ type: 'abort' });
        } catch {
          // ignore
        }
      }
      cleanup();
      reject(makeAbortError());
    };

    if (opts.signal) {
      if (opts.signal.aborted) {
        for (const w of workers) w.terminate();
        reject(makeAbortError());
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const emitAggregateProgress = (currentPath?: string) => {
      const bytesHashed = perWorkerBytes.reduce((n, x) => n + x, 0);
      const filesCompleted = perWorkerCompleted.reduce((n, x) => n + x, 0);
      opts.onProgress?.({
        bytesHashed,
        bytesTotal: totalBytes,
        filesCompleted,
        filesTotal: totalFiles,
        currentFilePath: currentPath,
      });
    };

    workers.forEach((worker, wi) => {
      worker.addEventListener('message', (ev) => {
        if (settled) return;
        const msg = ev.data;
        switch (msg.type) {
          case 'progress':
            perWorkerBytes[wi] = msg.progress.bytesHashed;
            perWorkerCompleted[wi] = msg.progress.filesCompleted;
            emitAggregateProgress(msg.progress.currentFilePath);
            break;
          case 'done':
            for (const entry of msg.entries) {
              const idx = pathIndex.get(entry.path);
              if (idx !== undefined) ordered[idx] = entry;
            }
            remaining--;
            if (remaining === 0) {
              cleanup();
              resolve(ordered.filter((e): e is VersionFileEntry => !!e));
            }
            break;
          case 'error':
            cleanup();
            reject(
              Object.assign(new Error(msg.message), { name: msg.name ?? 'Error' }),
            );
            break;
        }
      });
      worker.addEventListener('error', (ev) => {
        cleanup();
        reject(new Error(ev.message || 'worker error'));
      });
      worker.postMessage({ type: 'start', files: [...partitions[wi]] });
    });
  });
}

/* --------------------------------------------------------------------- */
/*  Default worker factory — bundler-dependent                           */
/* --------------------------------------------------------------------- */

function defaultWorkerFactory(): WorkerLike {
  // Next.js / Webpack 5 accepts `new Worker(new URL('...', import.meta.url))`
  // as a module worker. Vite + most modern bundlers do too.
  if (typeof Worker === 'undefined') {
    throw new Error(
      'versionBuilder: Worker is not available in this environment',
    );
  }
  return new Worker(new URL('./workers/versionBuilder.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike;
}

function makeAbortError(): Error {
  const E =
    typeof DOMException !== 'undefined'
      ? new DOMException('aborted', 'AbortError')
      : Object.assign(new Error('aborted'), { name: 'AbortError' });
  return E as Error;
}
