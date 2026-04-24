/**
 * Client-side wrapper for the off-main-thread manifest builder worker
 * (roost wave 3.2).
 *
 * Spawns the worker defined in `workers/manifestBuilder.worker.ts`,
 * forwards File objects via transferable-friendly messages, and returns
 * a promise that resolves with the finished manifest entries. Progress
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
  ManifestFileEntry,
  ManifestProgress,
  NamedBlob,
} from './chunking';

/* --------------------------------------------------------------------- */
/*  Wire protocol                                                        */
/* --------------------------------------------------------------------- */

export type WorkerInbound =
  | { type: 'start'; files: NamedBlob[] }
  | { type: 'abort' };

export type WorkerOutbound =
  | { type: 'progress'; progress: ManifestProgress }
  | { type: 'done'; entries: ManifestFileEntry[] }
  | { type: 'error'; message: string; name?: string };

/* --------------------------------------------------------------------- */
/*  Public API                                                           */
/* --------------------------------------------------------------------- */

export interface BuildOptions {
  onProgress?: (p: ManifestProgress) => void;
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
 * Build a manifest for the supplied files, off-main-thread.
 *
 * Resolves with the ordered list of `ManifestFileEntry` once every file
 * is hashed. Rejects on worker error or abort. The worker is terminated
 * on resolve, reject, or abort — no lingering threads.
 */
export async function buildManifest(
  files: readonly NamedBlob[],
  opts: BuildOptions = {},
): Promise<ManifestFileEntry[]> {
  // Env without Worker (Jest/Node unit tests, SSR snapshots, etc.) falls
  // back to the sync in-process path so behaviour is correct everywhere.
  // Browser prod always has Worker, so this branch doesn't cost real users
  // anything.
  if (!opts.workerFactory && typeof Worker === 'undefined') {
    const { buildManifestEntries } = await import('./chunking');
    return buildManifestEntries(files, {
      signal: opts.signal,
      onProgress: opts.onProgress,
    });
  }
  return new Promise<ManifestFileEntry[]>((resolve, reject) => {
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

/* --------------------------------------------------------------------- */
/*  Default worker factory — bundler-dependent                           */
/* --------------------------------------------------------------------- */

function defaultWorkerFactory(): WorkerLike {
  // Next.js / Webpack 5 accepts `new Worker(new URL('...', import.meta.url))`
  // as a module worker. Vite + most modern bundlers do too.
  if (typeof Worker === 'undefined') {
    throw new Error(
      'manifestBuilder: Worker is not available in this environment',
    );
  }
  return new Worker(new URL('./workers/manifestBuilder.worker.ts', import.meta.url), {
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
