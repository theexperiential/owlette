/**
 * Directory walk + sha-256 4 MiB chunker used by `roosts.push()`.
 *
 * Shape-compatible with the cli chunker (`cli/src/lib/chunker.ts`) —
 * we duplicate the code instead of sharing it because the sdk ships as
 * a standalone npm package and can't depend on the cli internals.
 */

import { createReadStream, promises as fs } from 'fs';
import { createHash } from 'crypto';
import { join, relative, resolve, sep } from 'path';

export const CHUNK_SIZE_BYTES = 4 * 1024 * 1024;

export interface ChunkedFileEntry {
  path: string;
  size: number;
  chunks: Array<{ hash: string; size: number }>;
}

export type ChunkProgressEvent =
  | { phase: 'discover'; fileCount: number; totalBytes: number }
  | {
      phase: 'hash';
      file: string;
      filesDone: number;
      filesTotal: number;
      bytesDone: number;
      bytesTotal: number;
    };

export interface ChunkDirectoryOpts {
  ignore?: readonly string[];
  onProgress?: (event: ChunkProgressEvent) => void;
}

async function walkFiles(root: string, ignore: Set<string>): Promise<string[]> {
  const absRoot = resolve(root);
  const files: string[] = [];

  async function recur(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (ignore.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await recur(full);
      } else if (entry.isFile()) {
        files.push(full);
      } else if (entry.isSymbolicLink()) {
        const target = await fs.realpath(full);
        const rel = relative(absRoot, target);
        if (rel.startsWith('..') || (rel.length > 0 && rel.split(sep).includes('..'))) {
          continue;
        }
        const stat = await fs.stat(full);
        if (stat.isDirectory()) await recur(full);
        else if (stat.isFile()) files.push(full);
      }
    }
  }

  await recur(absRoot);
  files.sort();
  return files;
}

export async function chunkOneFile(
  absPath: string,
  relPath: string,
): Promise<ChunkedFileEntry> {
  const stat = await fs.stat(absPath);
  const size = stat.size;
  if (size === 0) {
    throw new Error(
      `chunker: ${relPath} is zero bytes; zero-byte files cannot be versioned`,
    );
  }

  const chunks: ChunkedFileEntry['chunks'] = [];

  return new Promise<ChunkedFileEntry>((resolveResult, reject) => {
    let remainingInChunk = Math.min(CHUNK_SIZE_BYTES, size);
    let hasher = createHash('sha256');
    let currentChunkSize = 0;
    const stream = createReadStream(absPath, { highWaterMark: 64 * 1024 });

    function finaliseChunk(): void {
      chunks.push({
        hash: hasher.digest('hex'),
        size: currentChunkSize,
      });
      hasher = createHash('sha256');
      currentChunkSize = 0;
    }

    stream.on('data', (rawBuf: Buffer | string) => {
      let buf: Buffer = Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(rawBuf);
      while (buf.length > 0) {
        const take = Math.min(remainingInChunk, buf.length);
        const slice = buf.subarray(0, take);
        hasher.update(slice);
        currentChunkSize += take;
        remainingInChunk -= take;
        buf = buf.subarray(take);
        if (remainingInChunk === 0) {
          finaliseChunk();
          const consumed = chunks.reduce((n, c) => n + c.size, 0);
          const remainingTotal = size - consumed;
          remainingInChunk = Math.min(CHUNK_SIZE_BYTES, remainingTotal);
          if (remainingInChunk === 0) break;
        }
      }
    });

    stream.on('end', () => {
      if (currentChunkSize > 0) finaliseChunk();
      resolveResult({ path: relPath, size, chunks });
    });

    stream.on('error', (err) => reject(err));
  });
}

export async function chunkDirectory(
  root: string,
  opts: ChunkDirectoryOpts = {},
): Promise<ChunkedFileEntry[]> {
  const absRoot = resolve(root);
  const ignore = new Set<string>(['.git', 'node_modules', ...(opts.ignore ?? [])]);
  const files = await walkFiles(absRoot, ignore);

  const withSizes: Array<{ abs: string; rel: string; size: number }> = [];
  for (const abs of files) {
    const stat = await fs.stat(abs);
    if (stat.size === 0) continue;
    withSizes.push({
      abs,
      rel: relative(absRoot, abs).split(sep).join('/'),
      size: stat.size,
    });
  }

  const totalBytes = withSizes.reduce((n, f) => n + f.size, 0);
  opts.onProgress?.({ phase: 'discover', fileCount: withSizes.length, totalBytes });

  const entries: ChunkedFileEntry[] = [];
  let filesDone = 0;
  let bytesDone = 0;
  for (const f of withSizes) {
    opts.onProgress?.({
      phase: 'hash',
      file: f.rel,
      filesDone,
      filesTotal: withSizes.length,
      bytesDone,
      bytesTotal: totalBytes,
    });
    const entry = await chunkOneFile(f.abs, f.rel);
    entries.push(entry);
    filesDone += 1;
    bytesDone += f.size;
  }
  opts.onProgress?.({
    phase: 'hash',
    file: '',
    filesDone,
    filesTotal: withSizes.length,
    bytesDone,
    bytesTotal: totalBytes,
  });

  return entries;
}

export function uniqueHashes(files: readonly ChunkedFileEntry[]): string[] {
  const set = new Set<string>();
  for (const f of files) for (const c of f.chunks) set.add(c.hash);
  return Array.from(set);
}
