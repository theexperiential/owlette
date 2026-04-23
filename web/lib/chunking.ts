/**
 * Pure chunking + SHA-256 digestion for roost manifest building (wave 3.2).
 *
 * Browser uploads slice each File into fixed 4 MiB chunks, hash every
 * chunk with Web Crypto, and build a manifest entry listing the chunk
 * hashes + per-file total size. That's this module.
 *
 * **Why split from the worker**: the worker body is a thin message-loop
 * wrapping these functions. Extracting the logic lets Jest exercise
 * the algorithms (chunk count, boundary arithmetic, end-to-end sha-256
 * integrity) without the main-thread-offload machinery — the worker
 * is then a trivial glue layer whose only job is not-blocking-the-UI.
 *
 * The browser's `File` extends `Blob`; both have `.slice(start, end)`
 * that returns a Blob (view, not a copy) and `.arrayBuffer()` that
 * reads the bytes. We rely on those primitives only — no Node-only
 * APIs in this module.
 */

/** Fixed chunk size for roost CAS. 4 MiB is the OCI manifest v1.1 default. */
export const CHUNK_SIZE_BYTES = 4 * 1024 * 1024;

/** Output entry for one input File — matches the manifest schema's `files[i]`. */
export interface ManifestFileEntry {
  /** Relative path within the dropped folder (forward-slash separators). */
  path: string;
  /** Total file size in bytes (sum of chunk sizes — tautology, but stated). */
  size: number;
  /** Chunk descriptors in file order. */
  chunks: Array<{ hash: string; size: number }>;
}

/** Progress events emitted while building a manifest. */
export interface ManifestProgress {
  /** Bytes hashed so far across all files. */
  bytesHashed: number;
  /** Total bytes the caller handed us up front. */
  bytesTotal: number;
  /** Files fully completed. */
  filesCompleted: number;
  /** Total files to process. */
  filesTotal: number;
  /** Current file being hashed, if any. */
  currentFilePath?: string;
}

/** Minimal shape we need from the Web Crypto SubtleCrypto interface. */
export interface SubtleCryptoLike {
  digest(algorithm: 'SHA-256', data: BufferSource): Promise<ArrayBuffer>;
}

/** Minimal shape we need from Blob (also satisfied by File). */
export interface BlobLike {
  readonly size: number;
  slice(start: number, end?: number): BlobLike;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Input: a Blob/File paired with its roost-relative path. */
export interface NamedBlob {
  path: string;
  blob: BlobLike;
}

/* --------------------------------------------------------------------- */
/*  Core: chunk + hash one file                                          */
/* --------------------------------------------------------------------- */

export interface HashOneFileOptions {
  /** For progress reporting — invoked after each chunk. */
  onChunkHashed?: (chunkSize: number) => void;
  /** Injectable for tests; defaults to globalThis.crypto.subtle. */
  subtle?: SubtleCryptoLike;
  /** Abort signal; if aborted, rejects with a DOMException-shaped error. */
  signal?: AbortSignal;
}

/**
 * Hash one file into a ManifestFileEntry. Chunks are read and hashed
 * sequentially — parallelism within a single file would increase peak
 * memory for a very small wall-clock win (crypto.subtle is already
 * async, so the UI thread is free either way).
 *
 * Parallelism across multiple files is the caller's job (`buildManifest`
 * below processes files sequentially; the web-worker wrapper posts
 * progress after each chunk so the UI stays responsive).
 */
export async function hashOneFile(
  named: NamedBlob,
  opts: HashOneFileOptions = {},
): Promise<ManifestFileEntry> {
  const subtle = opts.subtle ?? resolveSubtle();
  const size = named.blob.size;
  const chunks: ManifestFileEntry['chunks'] = [];

  if (size === 0) {
    // Zero-byte file. The manifest schema requires `chunks[i].size > 0`,
    // so a zero-byte file cannot be represented. Callers must filter
    // these out before calling us; we fail loud so silent omission
    // never happens at this layer.
    throw new Error(
      `chunking: file ${JSON.stringify(named.path)} is zero bytes; ` +
        `zero-byte files cannot be manifested — filter them out upstream`,
    );
  }

  for (let offset = 0; offset < size; offset += CHUNK_SIZE_BYTES) {
    if (opts.signal?.aborted) {
      throw makeAbortError();
    }
    const end = Math.min(offset + CHUNK_SIZE_BYTES, size);
    const slice = named.blob.slice(offset, end);
    const bytes = await slice.arrayBuffer();
    const digest = await subtle.digest('SHA-256', bytes);
    chunks.push({
      hash: bufferToHex(digest),
      size: end - offset,
    });
    opts.onChunkHashed?.(end - offset);
  }

  return {
    path: named.path,
    size,
    chunks,
  };
}

/* --------------------------------------------------------------------- */
/*  Bulk: build a manifest-entry list for a folder                       */
/* --------------------------------------------------------------------- */

export interface BuildManifestOptions {
  onProgress?: (p: ManifestProgress) => void;
  subtle?: SubtleCryptoLike;
  signal?: AbortSignal;
}

/**
 * Hash an entire folder of NamedBlobs into the `files[]` array of a
 * roost manifest. Files are processed sequentially; per-chunk progress
 * events fire so the UI can show a smooth bar.
 *
 * Zero-byte files are skipped (the manifest schema requires at least
 * one positive-size chunk per file). Empty folders are valid input —
 * returns `[]`.
 */
export async function buildManifestEntries(
  files: readonly NamedBlob[],
  opts: BuildManifestOptions = {},
): Promise<ManifestFileEntry[]> {
  const usableFiles = files.filter((f) => f.blob.size > 0);
  const bytesTotal = usableFiles.reduce((n, f) => n + f.blob.size, 0);
  const filesTotal = usableFiles.length;

  let bytesHashed = 0;
  let filesCompleted = 0;

  const entries: ManifestFileEntry[] = [];
  for (const f of usableFiles) {
    if (opts.signal?.aborted) throw makeAbortError();

    opts.onProgress?.({
      bytesHashed,
      bytesTotal,
      filesCompleted,
      filesTotal,
      currentFilePath: f.path,
    });

    const entry = await hashOneFile(f, {
      subtle: opts.subtle,
      signal: opts.signal,
      onChunkHashed: (chunkSize) => {
        bytesHashed += chunkSize;
        opts.onProgress?.({
          bytesHashed,
          bytesTotal,
          filesCompleted,
          filesTotal,
          currentFilePath: f.path,
        });
      },
    });
    entries.push(entry);
    filesCompleted += 1;
  }

  opts.onProgress?.({
    bytesHashed,
    bytesTotal,
    filesCompleted,
    filesTotal,
  });

  return entries;
}

/* --------------------------------------------------------------------- */
/*  Utilities                                                            */
/* --------------------------------------------------------------------- */

/** Lowercase hex encoding of an ArrayBuffer — format the manifest expects. */
export function bufferToHex(buf: ArrayBuffer): string {
  const u8 = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < u8.length; i++) {
    const b = u8[i];
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

/** Resolve the Web Crypto SubtleCrypto at call-time (browser + Node 20). */
function resolveSubtle(): SubtleCryptoLike {
  const g = globalThis as unknown as { crypto?: { subtle?: SubtleCryptoLike } };
  if (!g.crypto?.subtle) {
    throw new Error(
      'chunking: Web Crypto subtle API is not available in this environment',
    );
  }
  return g.crypto.subtle;
}

function makeAbortError(): Error {
  // DOMException shape; falls back to a plain Error in environments
  // without DOMException (none in-scope, but defensive).
  const E =
    typeof DOMException !== 'undefined'
      ? new DOMException('aborted', 'AbortError')
      : Object.assign(new Error('aborted'), { name: 'AbortError' });
  return E as Error;
}

/* --------------------------------------------------------------------- */
/*  Aggregate stats (for pre-upload summary UIs)                         */
/* --------------------------------------------------------------------- */

/**
 * Summarise a manifest for display: total bytes, total chunks, dedup
 * estimate (unique chunk hashes / total chunk slots). Pure — derive-only.
 */
export function summariseManifest(entries: readonly ManifestFileEntry[]): {
  fileCount: number;
  totalBytes: number;
  totalChunks: number;
  uniqueChunks: number;
} {
  let totalBytes = 0;
  let totalChunks = 0;
  const unique = new Set<string>();
  for (const e of entries) {
    totalBytes += e.size;
    totalChunks += e.chunks.length;
    for (const c of e.chunks) unique.add(c.hash);
  }
  return {
    fileCount: entries.length,
    totalBytes,
    totalChunks,
    uniqueChunks: unique.size,
  };
}
