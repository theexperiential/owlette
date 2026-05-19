/**
 * roost upload orchestrator (wave 3.1).
 *
 * Chain: hash → /api/chunks/check → /api/chunks/upload-urls → parallel
 * PUTs via uploadQueue → /api/roosts/{id}/versions.
 *
 * Uses the wave-3 primitives we've already built — no Uppy, no tus.
 * The IndexedDB-backed upload queue gives us tab-close recovery; the
 * chunker is off-main-thread; pre-upload + dedup happen at the check step.
 */

import { type VersionFileEntry, type NamedBlob, VERSION_MEDIA_TYPE } from './chunking';
import { buildVersion } from './versionBuilder';
import { openIndexedDBStore } from './uploadQueue.idb';
import { runUploadQueue, type QueueStore } from './uploadQueue';

export type UploadPhase =
  | 'idle'
  | 'hashing'
  | 'checking'
  | 'uploading'
  | 'finalizing'
  | 'done'
  | 'error';

export interface UploadProgress {
  phase: UploadPhase;
  /** Fraction 0..1 — bytes hashed so far vs total to hash. Populated during `hashing`. */
  hashFraction?: number;
  /** Fraction 0..1 — bytes uploaded vs total bytes to upload. Populated during `uploading`. */
  uploadFraction?: number;
  /** Human-readable status line. */
  message?: string;
}

export interface UploadFolderOptions {
  siteId: string;
  roostId: string;
  files: NamedBlob[];
  /** Human-readable name — shown on the /roost page. */
  name: string;
  /** Machine IDs to dispatch sync_pull to once the version finalises. */
  targets: string[];
  /** Optional per-machine extract path override (falls back to ~/Documents/Owlette/). */
  extractPath?: string;
  /** Optional commit-message style description (≤500 chars, plaintext). */
  description?: string;
  onProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal;
  /** Override stores for tests — prod uses openIndexedDBStore per-session. */
  queueStore?: QueueStore;
  fetchFn?: typeof fetch;
}

export interface UploadResult {
  versionId: string;
  versionNumber: number;
  currentVersionId: string;
  previousVersionId: string | null;
  /** Bytes that actually transferred after dedup. */
  uploadedBytes: number;
  /** Total version bytes (upload + already-present). */
  totalBytes: number;
}

/** Error thrown by the orchestrator with a `.phase` indicating where it happened. */
export class RoostUploadError extends Error {
  constructor(
    message: string,
    public readonly phase: UploadPhase,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RoostUploadError';
  }
}

/**
 * Run the full upload pipeline. Resolves with the persisted version
 * pointer on success; rejects with `RoostUploadError` on any phase failure.
 */
export async function uploadFolder(
  opts: UploadFolderOptions,
): Promise<UploadResult> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  const report = (p: UploadProgress) => opts.onProgress?.(p);

  // ── 1. hash ─────────────────────────────────────────────────────
  // Runs in a Web Worker (see versionBuilder.ts) so a 100 GB folder's
  // hashing doesn't freeze the dashboard. Main thread only handles
  // progress ticks. Pre-worker-wiring the UI would visibly jank during
  // any meaningful upload.
  report({ phase: 'hashing', message: 'reading + hashing your roost' });
  let entries: VersionFileEntry[];
  try {
    entries = await buildVersion(opts.files, {
      signal: opts.signal,
      onProgress: (p) =>
        report({
          phase: 'hashing',
          hashFraction: p.bytesTotal > 0 ? p.bytesHashed / p.bytesTotal : 0,
          message: p.currentFilePath
            ? `hashing ${p.currentFilePath}`
            : 'hashing…',
        }),
    });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new RoostUploadError(
      `hash phase failed: ${(err as Error).message}`,
      'hashing',
      err,
    );
  }

  if (entries.length === 0) {
    throw new RoostUploadError(
      'no files to upload (all files were zero bytes or rejected)',
      'hashing',
    );
  }

  const totalBytes = entries.reduce((n, e) => n + e.size, 0);
  const allHashes = new Set<string>();
  const chunkSize = new Map<string, number>();
  for (const entry of entries) {
    for (const c of entry.chunks) {
      allHashes.add(c.hash);
      chunkSize.set(c.hash, c.size);
    }
  }

  // ── 2. check ────────────────────────────────────────────────────
  // Server-side cap is 1000 hashes per request (MAX_HASHES_PER_REQUEST in
  // web/app/api/_shared.ts). Anything over that gets 400. Batch at 500 to
  // leave headroom + keep individual requests small enough that one
  // transient failure only costs a retry of that batch, not everything.
  report({ phase: 'checking', message: 'checking what is already uploaded' });
  let missing: string[];
  try {
    const allHashesArr = [...allHashes];
    const missingBatches = await batchedHashRequest(
      allHashesArr,
      async (batch) => {
        const res = await fetchFn('/api/chunks/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ siteId: opts.siteId, hashes: batch }),
          signal: opts.signal,
        });
        if (!res.ok) throw await toProblem(res, 'check');
        const body = (await res.json()) as { missing?: string[] };
        return Array.isArray(body.missing) ? body.missing : [];
      },
    );
    missing = missingBatches.flat();
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new RoostUploadError(
      `check phase failed: ${(err as Error).message}`,
      'checking',
      err,
    );
  }

  // ── 3. upload the missing chunks ────────────────────────────────
  let uploadedBytes = 0;
  if (missing.length > 0) {
    let urls: Record<string, string>;
    try {
      // Same batching story as /check above.
      const urlBatches = await batchedHashRequest(missing, async (batch) => {
        const res = await fetchFn('/api/chunks/upload-urls', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': `roost-${opts.siteId}-${opts.roostId}-${Date.now()}`,
          },
          body: JSON.stringify({ siteId: opts.siteId, hashes: batch }),
          signal: opts.signal,
        });
        if (!res.ok) throw await toProblem(res, 'upload-urls');
        const body = (await res.json()) as { urls?: Record<string, string> };
        return body.urls ?? {};
      });
      urls = Object.assign({}, ...urlBatches);
    } catch (err) {
      if (isAbort(err)) throw err;
      throw new RoostUploadError(
        `signed-url phase failed: ${(err as Error).message}`,
        'uploading',
        err,
      );
    }

    // Seed the upload queue with a task per missing chunk. The task's
    // payload carries both the signed URL and the chunk bytes we sliced
    // out of the original blobs — no re-hashing on retry, no re-seek.
    const store =
      opts.queueStore ??
      openIndexedDBStore(`roost-upload-${opts.siteId}-${opts.roostId}`);

    for (const hash of missing) {
      const url = urls[hash];
      if (!url) {
        throw new RoostUploadError(
          `server did not return a signed URL for chunk ${hash.slice(0, 12)}…`,
          'uploading',
        );
      }
      const bytes = locateChunkBytes(opts.files, entries, hash);
      if (!bytes) {
        throw new RoostUploadError(
          `chunk ${hash.slice(0, 12)}… not found in input files (dedup index miss)`,
          'uploading',
        );
      }
      const size = chunkSize.get(hash) ?? bytes.size;
      await store.put({
        id: hash,
        state: 'pending',
        attempt: 0,
        payload: { url, bytes },
        updatedAt: Date.now(),
        sizeBytes: size,
      });
    }

    report({ phase: 'uploading', uploadFraction: 0, message: 'uploading chunks' });

    const result = await runUploadQueue(
      store,
      async (task) => {
        const { url, bytes } = task.payload as { url: string; bytes: Blob };
        const res = await fetchFn(url, {
          method: 'PUT',
          body: bytes,
          signal: opts.signal,
        });
        if (!res.ok) {
          throw new Error(`PUT ${task.id.slice(0, 12)}… → ${res.status}`);
        }
      },
      {
        concurrency: 4,
        signal: opts.signal,
        onProgress: (s) => {
          uploadedBytes = s.bytesSucceeded;
          report({
            phase: 'uploading',
            uploadFraction: s.bytesTotal > 0 ? s.bytesSucceeded / s.bytesTotal : 0,
            message: `${s.succeeded}/${s.total} chunks uploaded`,
          });
        },
      },
    );

    if (result.aborted) {
      throw new RoostUploadError('upload cancelled', 'uploading');
    }
    if (result.failed > 0) {
      throw new RoostUploadError(
        `${result.failed} chunk upload(s) failed after retry cap`,
        'uploading',
      );
    }
  }

  // ── 4. finalize ─────────────────────────────────────────────────
  report({ phase: 'finalizing', message: 'publishing version' });
  const versionBody = buildOciVersion(entries);
  let body: {
    versionId?: string;
    versionNumber?: number;
    currentVersionId?: string;
    previousVersionId?: string | null;
  };
  try {
    const res = await fetchFn(`/api/roosts/${encodeURIComponent(opts.roostId)}/versions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `roost-finalize-${opts.siteId}-${opts.roostId}-${Date.now()}`,
      },
      body: JSON.stringify({
        siteId: opts.siteId,
        version: versionBody,
        name: opts.name,
        targets: opts.targets,
        ...(opts.extractPath ? { extractPath: opts.extractPath } : {}),
        ...(opts.description ? { description: opts.description } : {}),
      }),
      signal: opts.signal,
    });
    if (!res.ok) throw await toProblem(res, 'finalize');
    body = await res.json();
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new RoostUploadError(
      `finalize phase failed: ${(err as Error).message}`,
      'finalizing',
      err,
    );
  }

  if (!body.versionId) {
    throw new RoostUploadError(
      'finalize returned no versionId',
      'finalizing',
    );
  }

  report({ phase: 'done', message: 'done' });
  return {
    versionId: body.versionId,
    versionNumber: typeof body.versionNumber === 'number' ? body.versionNumber : 0,
    currentVersionId: body.currentVersionId ?? body.versionId,
    previousVersionId: body.previousVersionId ?? null,
    uploadedBytes,
    totalBytes,
  };
}

/* --------------------------------------------------------------------- */
/*  Helpers                                                              */
/* --------------------------------------------------------------------- */

/**
 * Given the input files + the computed version entries, slice the exact
 * bytes for `hash` out of the original blob without re-hashing. Walks
 * the entry list in order — the first entry+chunk with a matching hash
 * wins (dedup means the same bytes may appear in multiple entries).
 */
export function locateChunkBytes(
  files: readonly NamedBlob[],
  entries: readonly VersionFileEntry[],
  hash: string,
): Blob | null {
  const byPath = new Map<string, Blob>();
  for (const f of files) byPath.set(f.path, f.blob as unknown as Blob);
  for (const entry of entries) {
    const blob = byPath.get(entry.path);
    if (!blob) continue;
    let offset = 0;
    for (const chunk of entry.chunks) {
      if (chunk.hash === hash) {
        return blob.slice(offset, offset + chunk.size);
      }
      offset += chunk.size;
    }
  }
  return null;
}

function buildOciVersion(entries: VersionFileEntry[]) {
  // Content-addressed: version body contains ONLY content-identifying
  // fields. `createdAt` / `createdBy` / `siteId` / `name` previously
  // lived in `config` but they're metadata, not content — and embedding
  // a wall-clock timestamp in the hashed body meant byte-identical
  // uploads produced different version IDs, defeating dedup at the
  // version level. Those fields are already stored on the Firestore
  // version subdoc (see web/app/api/roosts/[roostId]/versions/route.ts),
  // so removing them here is a pure de-duplication without any loss
  // of metadata.
  //
  // `config: {}` satisfies agent-side sync_version validation, which
  // requires `config` to be a dict but doesn't inspect its contents.
  return {
    schemaVersion: 2,
    mediaType: VERSION_MEDIA_TYPE,
    config: {},
    files: entries,
  };
}

/**
 * Parse an RFC 7807 problem+json body from a failed response and wrap
 * the detail into a plain Error. Roost routes return this envelope
 * (wave 2a.8) — surfacing the `detail` field gives callers actionable
 * copy instead of "HTTP 400".
 */
async function toProblem(res: Response, context: string): Promise<Error> {
  try {
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('json')) {
      const body = (await res.json()) as { title?: string; detail?: string };
      return new Error(
        `${context}: ${body.detail ?? body.title ?? `HTTP ${res.status}`}`,
      );
    }
  } catch {
    /* fall through to generic */
  }
  return new Error(`${context}: HTTP ${res.status}`);
}

function isAbort(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.message === 'aborted')
  );
}

/**
 * Batch size for hash-list API calls. Server cap is
 * MAX_HASHES_PER_REQUEST=1000 (see web/app/api/_shared.ts); we stay well
 * under so a future cap reduction doesn't regress us, and so one failed
 * batch only requires retrying ~500 hashes worth of work.
 */
const HASH_BATCH_SIZE = 500;

/**
 * Run `fn` on slices of `items` of up to `HASH_BATCH_SIZE`, sequentially.
 * Sequential (not parallel) because the server-side operations that
 * consume these batches — presign URL mint, R2 HEAD for /chunks/check —
 * are CPU/IO-proportional to batch count and we don't want to swamp the
 * edge with 20 concurrent presign bursts on a large roost. The batches
 * themselves are cheap; total wall time for 10k hashes is ~5-10s on a
 * warm connection.
 */
async function batchedHashRequest<R>(
  items: readonly string[],
  fn: (batch: string[]) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const out: R[] = [];
  for (let i = 0; i < items.length; i += HASH_BATCH_SIZE) {
    out.push(await fn(items.slice(i, i + HASH_BATCH_SIZE)));
  }
  return out;
}
