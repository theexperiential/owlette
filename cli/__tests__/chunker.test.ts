import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import {
  CHUNK_SIZE_BYTES,
  chunkDirectory,
  chunkOneFile,
  walkFiles,
} from '../src/lib/chunker';

function mkTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'roost-cli-chunker-'));
  writeFileSync(join(root, 'a.txt'), 'hello world');
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'b.txt'), 'nested');
  writeFileSync(join(root, 'empty.txt'), ''); // zero-byte; should be skipped
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', 'ignored.txt'), 'should-not-appear');
  return root;
}

describe('walkFiles', () => {
  it('lists all files recursively and skips ignored dirs', async () => {
    const root = mkTree();
    const files = await walkFiles(root);
    const rels = files.map((f) => f.replace(root, '').replace(/\\/g, '/').replace(/^\//, ''));
    expect(rels).toContain('a.txt');
    expect(rels).toContain('sub/b.txt');
    expect(rels).toContain('empty.txt'); // still listed; zero-byte filter lives in chunkDirectory
    expect(rels.some((r) => r.includes('node_modules'))).toBe(false);
  });
});

describe('chunkOneFile', () => {
  it('computes sha-256 matching node:crypto for a small file', async () => {
    const root = mkTree();
    const entry = await chunkOneFile(join(root, 'a.txt'), 'a.txt');
    const expected = createHash('sha256').update('hello world').digest('hex');
    expect(entry.chunks).toHaveLength(1);
    expect(entry.chunks[0]?.hash).toBe(expected);
    expect(entry.chunks[0]?.size).toBe(11);
    expect(entry.size).toBe(11);
    expect(entry.path).toBe('a.txt');
  });

  it('throws for zero-byte files', async () => {
    const root = mkTree();
    await expect(chunkOneFile(join(root, 'empty.txt'), 'empty.txt')).rejects.toThrow(/zero bytes/);
  });

  it('splits a file larger than CHUNK_SIZE_BYTES into multiple chunks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'roost-cli-big-'));
    const path = join(root, 'big.bin');
    const buf = Buffer.alloc(CHUNK_SIZE_BYTES + 7);
    for (let i = 0; i < buf.length; i++) buf[i] = i % 256;
    writeFileSync(path, buf);
    const entry = await chunkOneFile(path, 'big.bin');
    expect(entry.chunks).toHaveLength(2);
    expect(entry.chunks[0]?.size).toBe(CHUNK_SIZE_BYTES);
    expect(entry.chunks[1]?.size).toBe(7);
    // Chunk hashes should match the streamed halves.
    const h0 = createHash('sha256').update(buf.subarray(0, CHUNK_SIZE_BYTES)).digest('hex');
    const h1 = createHash('sha256').update(buf.subarray(CHUNK_SIZE_BYTES)).digest('hex');
    expect(entry.chunks[0]?.hash).toBe(h0);
    expect(entry.chunks[1]?.hash).toBe(h1);
  });
});

describe('chunkDirectory', () => {
  it('skips zero-byte files and sorts by path', async () => {
    const root = mkTree();
    const entries = await chunkDirectory(root);
    const paths = entries.map((e) => e.path);
    expect(paths).toContain('a.txt');
    expect(paths).toContain('sub/b.txt');
    expect(paths).not.toContain('empty.txt');
  });

  it('emits discover + hash progress events', async () => {
    const root = mkTree();
    const events: string[] = [];
    await chunkDirectory(root, {
      onProgress: (evt) => events.push(evt.phase),
    });
    expect(events[0]).toBe('discover');
    expect(events.filter((p) => p === 'hash').length).toBeGreaterThan(0);
  });
});
