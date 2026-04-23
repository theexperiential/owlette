/**
 * @jest-environment node
 *
 * tests for web/lib/chunking.ts (roost wave 3.2).
 *
 * Pure-logic coverage — no DOM Worker. Node 20's built-in Web Crypto
 * (`globalThis.crypto.subtle`) satisfies the SubtleCryptoLike surface
 * and `File` from `node:buffer` satisfies BlobLike. The worker wrapper
 * in manifestBuilder.ts is thin glue — left for integration tests when
 * wave 1.6 infrastructure lands.
 */

import { createHash } from 'crypto';
import {
  bufferToHex,
  buildManifestEntries,
  CHUNK_SIZE_BYTES,
  hashOneFile,
  summariseManifest,
  type NamedBlob,
} from '@/lib/chunking';

/* --------------------------------------------------------------------- */
/*  Node 20 Blob as BlobLike                                             */
/* --------------------------------------------------------------------- */

function blobOf(bytes: Buffer | Uint8Array): NamedBlob['blob'] {
  // in-memory BlobLike — satisfies { size, slice, arrayBuffer } without
  // depending on either browser Blob or node:buffer.Blob type quirks.
  const size = bytes.byteLength;
  return {
    get size() { return size; },
    slice(start: number, end?: number) {
      const endIdx = end ?? size;
      return blobOf(Buffer.from(bytes.subarray(start, endIdx)));
    },
    async arrayBuffer(): Promise<ArrayBuffer> {
      const out = new Uint8Array(bytes.byteLength);
      out.set(bytes);
      return out.buffer;
    },
  };
}

function named(path: string, bytes: Buffer | Uint8Array): NamedBlob {
  return { path, blob: blobOf(bytes) };
}

function reference_sha256_hex(bytes: Buffer | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/* --------------------------------------------------------------------- */
/*  bufferToHex                                                          */
/* --------------------------------------------------------------------- */

describe('bufferToHex', () => {
  it('pads single-digit bytes with leading zero', () => {
    const ab = new Uint8Array([0x00, 0x01, 0x0f, 0xa0, 0xff]).buffer;
    expect(bufferToHex(ab)).toBe('00010fa0ff');
  });

  it('empty buffer → empty string', () => {
    expect(bufferToHex(new ArrayBuffer(0))).toBe('');
  });
});

/* --------------------------------------------------------------------- */
/*  hashOneFile                                                          */
/* --------------------------------------------------------------------- */

describe('hashOneFile', () => {
  it('hashes a small file as exactly one chunk', async () => {
    const data = Buffer.from('hello roost');
    const entry = await hashOneFile(named('a.toe', data));
    expect(entry.chunks.length).toBe(1);
    expect(entry.chunks[0].size).toBe(data.length);
    expect(entry.chunks[0].hash).toBe(reference_sha256_hex(data));
    expect(entry.size).toBe(data.length);
    expect(entry.path).toBe('a.toe');
  });

  it('produces exactly 2 chunks for a file 1 byte over CHUNK_SIZE_BYTES', async () => {
    const data = Buffer.alloc(CHUNK_SIZE_BYTES + 1, 0x42);
    const entry = await hashOneFile(named('big.bin', data));
    expect(entry.chunks.length).toBe(2);
    expect(entry.chunks[0].size).toBe(CHUNK_SIZE_BYTES);
    expect(entry.chunks[1].size).toBe(1);
    expect(entry.size).toBe(CHUNK_SIZE_BYTES + 1);
  });

  it('chunk sizes sum to file size', async () => {
    // unusual but valid size — 3 chunks with a partial last one.
    const size = CHUNK_SIZE_BYTES * 2 + 1234;
    const data = Buffer.alloc(size, 0x7f);
    const entry = await hashOneFile(named('x', data));
    const sum = entry.chunks.reduce((n, c) => n + c.size, 0);
    expect(sum).toBe(size);
  });

  it('chunk hashes match a reference SHA-256 over the exact byte range', async () => {
    // two-chunk file — each chunk hash must match Node's crypto on the
    // corresponding slice. regression for "hashed wrong bytes" bugs.
    const fullSize = CHUNK_SIZE_BYTES + 100;
    const data = Buffer.alloc(fullSize);
    for (let i = 0; i < fullSize; i++) data[i] = i & 0xff;
    const entry = await hashOneFile(named('striped.bin', data));
    expect(entry.chunks[0].hash).toBe(
      reference_sha256_hex(data.subarray(0, CHUNK_SIZE_BYTES)),
    );
    expect(entry.chunks[1].hash).toBe(
      reference_sha256_hex(data.subarray(CHUNK_SIZE_BYTES, fullSize)),
    );
  });

  it('throws on zero-byte input (manifest schema forbids zero-size chunks)', async () => {
    await expect(
      hashOneFile(named('empty.bin', Buffer.alloc(0))),
    ).rejects.toThrow(/zero bytes/);
  });

  it('reports per-chunk progress', async () => {
    const data = Buffer.alloc(CHUNK_SIZE_BYTES * 3 + 100, 0x33);
    const chunkSizesSeen: number[] = [];
    await hashOneFile(named('multi.bin', data), {
      onChunkHashed: (sz) => chunkSizesSeen.push(sz),
    });
    expect(chunkSizesSeen).toEqual([
      CHUNK_SIZE_BYTES,
      CHUNK_SIZE_BYTES,
      CHUNK_SIZE_BYTES,
      100,
    ]);
  });

  it('honours AbortSignal and aborts BEFORE the next chunk', async () => {
    const data = Buffer.alloc(CHUNK_SIZE_BYTES * 3, 0x66);
    const controller = new AbortController();
    const promise = hashOneFile(named('aborted.bin', data), {
      signal: controller.signal,
      onChunkHashed: () => controller.abort(),
    });
    await expect(promise).rejects.toHaveProperty('name', 'AbortError');
  });
});

/* --------------------------------------------------------------------- */
/*  buildManifestEntries                                                 */
/* --------------------------------------------------------------------- */

describe('buildManifestEntries', () => {
  it('returns empty array for empty input', async () => {
    const entries = await buildManifestEntries([]);
    expect(entries).toEqual([]);
  });

  it('filters zero-byte files silently (upstream caller concern)', async () => {
    const entries = await buildManifestEntries([
      named('good.toe', Buffer.from('abc')),
      named('empty.toe', Buffer.alloc(0)),
    ]);
    expect(entries.length).toBe(1);
    expect(entries[0].path).toBe('good.toe');
  });

  it('preserves input order', async () => {
    const entries = await buildManifestEntries([
      named('a.toe', Buffer.from('a')),
      named('b.toe', Buffer.from('b')),
      named('c.toe', Buffer.from('c')),
    ]);
    expect(entries.map((e) => e.path)).toEqual(['a.toe', 'b.toe', 'c.toe']);
  });

  it('progress events are monotonic and reach bytesTotal at completion', async () => {
    const files = [
      named('f1', Buffer.alloc(100, 1)),
      named('f2', Buffer.alloc(200, 2)),
      named('f3', Buffer.alloc(300, 3)),
    ];
    const progress: number[] = [];
    const result = await buildManifestEntries(files, {
      onProgress: (p) => {
        // monotonic
        expect(p.bytesHashed).toBeGreaterThanOrEqual(progress[progress.length - 1] ?? 0);
        progress.push(p.bytesHashed);
      },
    });
    expect(result.length).toBe(3);
    expect(progress[progress.length - 1]).toBe(600); // all bytes hashed
  });

  it('scales to 1 000 files (sanity smoke test)', async () => {
    // tiny files — the point is counting correctness, not throughput.
    const files: NamedBlob[] = [];
    for (let i = 0; i < 1_000; i++) {
      files.push(named(`f-${i}.bin`, Buffer.from(String(i))));
    }
    const entries = await buildManifestEntries(files);
    expect(entries.length).toBe(1_000);
    const summary = summariseManifest(entries);
    expect(summary.fileCount).toBe(1_000);
    expect(summary.totalChunks).toBeGreaterThanOrEqual(1_000);
  }, 30_000);

  it('scales to 10 000 files (sanity smoke test)', async () => {
    const files: NamedBlob[] = [];
    for (let i = 0; i < 10_000; i++) {
      files.push(named(`f-${i}.bin`, Buffer.from(String(i))));
    }
    const entries = await buildManifestEntries(files);
    expect(entries.length).toBe(10_000);
  }, 60_000);
});

/* --------------------------------------------------------------------- */
/*  summariseManifest                                                    */
/* --------------------------------------------------------------------- */

describe('summariseManifest', () => {
  it('counts files, bytes, chunks, and unique chunks', async () => {
    // two files that share content → dedup shows as uniqueChunks < totalChunks
    const entries = await buildManifestEntries([
      named('a', Buffer.from('same bytes')),
      named('b', Buffer.from('same bytes')),
      named('c', Buffer.from('other bytes')),
    ]);
    const s = summariseManifest(entries);
    expect(s.fileCount).toBe(3);
    expect(s.totalChunks).toBe(3);
    // a and b share a hash → unique count is 2.
    expect(s.uniqueChunks).toBe(2);
  });

  it('empty manifest → zeroed summary', () => {
    const s = summariseManifest([]);
    expect(s).toEqual({
      fileCount: 0,
      totalBytes: 0,
      totalChunks: 0,
      uniqueChunks: 0,
    });
  });
});
