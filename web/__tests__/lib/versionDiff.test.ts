/**
 * @jest-environment node
 *
 * tests for web/lib/versionDiff.ts (roost wave 3.7).
 */

import type { VersionFileEntry } from '@/lib/chunking';
import {
  DEFAULT_ROLLOUT_STRATEGY,
  diffVersions,
  summariseDiff,
} from '@/lib/versionDiff';

function entry(path: string, hashes: string[]): VersionFileEntry {
  return {
    path,
    size: hashes.length * 1024,
    chunks: hashes.map((h) => ({ hash: h, size: 1024 })),
  };
}

describe('diffVersions', () => {
  it('empty-to-empty → all zeros', () => {
    const d = diffVersions([], []);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([]);
    expect(d.unchanged).toEqual([]);
  });

  it('identical versions → everything unchanged', () => {
    const files = [entry('a.toe', ['h1']), entry('b.toe', ['h2'])];
    const d = diffVersions(files, files);
    expect(d.unchanged.length).toBe(2);
    expect(d.added.length + d.removed.length + d.changed.length).toBe(0);
  });

  it('detects added files (in `to` but not `from`)', () => {
    const from = [entry('a', ['h1'])];
    const to = [entry('a', ['h1']), entry('b', ['h2'])];
    const d = diffVersions(from, to);
    expect(d.added.map((f) => f.path)).toEqual(['b']);
    expect(d.unchanged.map((f) => f.path)).toEqual(['a']);
  });

  it('detects removed files (in `from` but not `to`)', () => {
    const from = [entry('a', ['h1']), entry('b', ['h2'])];
    const to = [entry('a', ['h1'])];
    const d = diffVersions(from, to);
    expect(d.removed.map((f) => f.path)).toEqual(['b']);
  });

  it('detects changed files (same path, different chunk hashes)', () => {
    const from = [entry('a.toe', ['h1', 'h2'])];
    const to = [entry('a.toe', ['h1', 'DIFFERENT'])];
    const d = diffVersions(from, to);
    expect(d.changed.length).toBe(1);
    expect(d.changed[0].path).toBe('a.toe');
    expect(d.changed[0].from.chunks[1].hash).toBe('h2');
    expect(d.changed[0].to.chunks[1].hash).toBe('DIFFERENT');
  });

  it('files with different chunk COUNT are flagged changed (regression)', () => {
    // same first chunk but different count — content differs by definition.
    const from = [entry('a.toe', ['h1'])];
    const to = [entry('a.toe', ['h1', 'h2'])];
    const d = diffVersions(from, to);
    expect(d.changed.length).toBe(1);
    expect(d.unchanged.length).toBe(0);
  });

  it('same chunks in DIFFERENT ORDER are flagged changed (regression)', () => {
    // the version preserves chunk order — reordered chunks = different bytes.
    const from = [entry('a.toe', ['h1', 'h2'])];
    const to = [entry('a.toe', ['h2', 'h1'])];
    const d = diffVersions(from, to);
    expect(d.changed.length).toBe(1);
  });

  it('output is sorted alphabetically by path (deterministic UI)', () => {
    const from: VersionFileEntry[] = [];
    const to = [entry('c', ['h']), entry('a', ['h']), entry('b', ['h'])];
    const d = diffVersions(from, to);
    expect(d.added.map((f) => f.path)).toEqual(['a', 'b', 'c']);
  });

  it('mixed add/remove/change/unchanged partitions cleanly', () => {
    const from = [
      entry('keeps', ['k1']),
      entry('changes', ['old']),
      entry('deletes', ['d1']),
    ];
    const to = [
      entry('keeps', ['k1']),
      entry('changes', ['new']),
      entry('adds', ['a1']),
    ];
    const d = diffVersions(from, to);
    expect(d.added.map((f) => f.path)).toEqual(['adds']);
    expect(d.removed.map((f) => f.path)).toEqual(['deletes']);
    expect(d.changed.map((c) => c.path)).toEqual(['changes']);
    expect(d.unchanged.map((f) => f.path)).toEqual(['keeps']);
    // no file double-counted
    const all = new Set([
      ...d.added.map((f) => f.path),
      ...d.removed.map((f) => f.path),
      ...d.changed.map((c) => c.path),
      ...d.unchanged.map((f) => f.path),
    ]);
    expect(all.size).toBe(4); // keeps + changes + deletes + adds
  });
});

describe('summariseDiff', () => {
  it('reports zero changes when versions are identical', () => {
    const files = [entry('a', ['h1'])];
    const s = summariseDiff(files, files);
    expect(s.hasChanges).toBe(false);
    expect(s.netBytesDelta).toBe(0);
  });

  it('reports net positive delta when target is larger', () => {
    const from = [entry('a', ['h1'])]; // 1024 bytes
    const to = [entry('a', ['h1']), entry('b', ['h2', 'h3'])]; // 1024 + 2048 = 3072
    const s = summariseDiff(from, to);
    expect(s.netBytesDelta).toBe(2048);
    expect(s.added).toBe(1);
  });

  it('reports net negative delta when target is smaller (rollback reclaims space)', () => {
    const from = [entry('a', ['h1', 'h2', 'h3'])]; // 3072
    const to = [entry('a', ['h1'])]; // 1024
    const s = summariseDiff(from, to);
    expect(s.netBytesDelta).toBe(-2048);
    expect(s.changed).toBe(1);
  });

  it('accepts a precomputed diff (avoids double-work)', () => {
    const from = [entry('a', ['h1'])];
    const to = [entry('a', ['h2'])];
    const d = diffVersions(from, to);
    const s = summariseDiff(from, to, d);
    expect(s.changed).toBe(1);
  });
});

describe('DEFAULT_ROLLOUT_STRATEGY', () => {
  it('defaults to canary (safe choice)', () => {
    expect(DEFAULT_ROLLOUT_STRATEGY).toBe('canary');
  });
});
