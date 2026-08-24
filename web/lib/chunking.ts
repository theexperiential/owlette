/**
 * Pure chunking + SHA-256 digestion for roost version building: slice each
 * File into fixed 4 MiB chunks, hash with Web Crypto, emit a version entry of
 * chunk hashes + per-file size.
 *
 * Split from the worker so Jest can exercise the algorithms (chunk count,
 * boundary arithmetic, sha-256 integrity) without the offload machinery.
 * Blob/File primitives only — no Node-only APIs.
 */

/** Fixed chunk size for roost CAS. 4 MiB is the OCI version v1.1 default. */
export const CHUNK_SIZE_BYTES = 4 * 1024 * 1024;

/** MediaType string stored inside the version envelope. */
export const VERSION_MEDIA_TYPE = 'application/vnd.owlette.version.v1+json';

/** Output entry for one input File — matches the version schema's `files[i]`. */
export interface VersionFileEntry {
  /** Relative path within the dropped folder (forward-slash separators). */
  path: string;
  /** Total file size in bytes. */
  size: number;
  /** Chunk descriptors in file order. */
  chunks: Array<{ hash: string; size: number }>;
}

/** Progress events emitted while building a version. */
export interface VersionProgress {
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

export interface HashOneFileOptions {
  /** For progress reporting — invoked after each chunk. */
  onChunkHashed?: (chunkSize: number) => void;
  /** Injectable for tests; defaults to globalThis.crypto.subtle. */
  subtle?: SubtleCryptoLike;
  /** Abort signal; if aborted, rejects with a DOMException-shaped error. */
  signal?: AbortSignal;
}

/**
 * Hash one file into a VersionFileEntry. Sequential within the file on
 * purpose: intra-file parallelism raises peak memory for near-zero wall-clock
 * gain, since crypto.subtle is already async. Cross-file parallelism is the
 * caller's call.
 */
export async function hashOneFile(
  named: NamedBlob,
  opts: HashOneFileOptions = {},
): Promise<VersionFileEntry> {
  const subtle = opts.subtle ?? resolveSubtle();
  const size = named.blob.size;
  const chunks: VersionFileEntry['chunks'] = [];

  if (size === 0) {
    // The version schema requires `chunks[i].size > 0`, so a zero-byte file is
    // unrepresentable. Fail loud rather than silently omit it.
    throw new Error(
      `chunking: file ${JSON.stringify(named.path)} is zero bytes; ` +
        `zero-byte files cannot be represented in a version — filter them out upstream`,
    );
  }

  // Double-buffered: read chunk N+1 while hashing chunk N. Halves per-chunk
  // wall time when disk-bound, no-op when not. Peak memory: 2 chunk buffers.
  const kickOffRead = (start: number): Promise<ArrayBuffer> | null => {
    if (start >= size) return null;
    const endLocal = Math.min(start + CHUNK_SIZE_BYTES, size);
    return named.blob.slice(start, endLocal).arrayBuffer();
  };

  let pendingRead = kickOffRead(0);
  for (let offset = 0; offset < size; offset += CHUNK_SIZE_BYTES) {
    if (opts.signal?.aborted) throw makeAbortError();
    const end = Math.min(offset + CHUNK_SIZE_BYTES, size);
    // Never null in the loop: we enter with offset < size, and kickOffRead
    // only returns null for start >= size.
    const bytes = await pendingRead!;
    // Prefetch before hashing so read and digest overlap.
    pendingRead = kickOffRead(end);
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

export interface BuildVersionOptions {
  onProgress?: (p: VersionProgress) => void;
  subtle?: SubtleCryptoLike;
  signal?: AbortSignal;
}

/**
 * Hash a folder of NamedBlobs into a version's `files[]`, sequentially, with
 * per-chunk progress. Zero-byte files are skipped (the schema needs at least
 * one positive-size chunk); an empty folder returns `[]`.
 */
export async function buildVersionEntries(
  files: readonly NamedBlob[],
  opts: BuildVersionOptions = {},
): Promise<VersionFileEntry[]> {
  const usableFiles = files.filter((f) => f.blob.size > 0);
  const bytesTotal = usableFiles.reduce((n, f) => n + f.blob.size, 0);
  const filesTotal = usableFiles.length;

  let bytesHashed = 0;
  let filesCompleted = 0;

  const entries: VersionFileEntry[] = [];
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

/** Lowercase hex encoding of an ArrayBuffer — format the version expects. */
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
  // DOMException shape, with a plain-Error fallback.
  const E =
    typeof DOMException !== 'undefined'
      ? new DOMException('aborted', 'AbortError')
      : Object.assign(new Error('aborted'), { name: 'AbortError' });
  return E as Error;
}

/**
 * Display summary: total bytes, total chunks, and a dedup estimate (unique
 * hashes / chunk slots). Pure.
 */
export function summariseVersion(entries: readonly VersionFileEntry[]): {
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
