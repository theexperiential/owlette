import {
  MANIFEST_MEDIA_TYPE,
  MANIFEST_SCHEMA_VERSION,
  buildManifest,
  summariseManifest,
  uniqueHashes,
} from '../src/lib/manifestBuilder';

const FILES = [
  { path: 'z/last.bin', size: 10, chunks: [{ hash: 'h1'.repeat(32), size: 10 }] },
  { path: 'a/first.bin', size: 5, chunks: [{ hash: 'h2'.repeat(32), size: 5 }] },
  { path: 'middle.bin', size: 20, chunks: [{ hash: 'h1'.repeat(32), size: 20 }] },
];

describe('buildManifest', () => {
  it('returns an OCI-shape object with the fixed mediaType + schemaVersion', () => {
    const m = buildManifest({ files: FILES, cliVersion: '0.0.1' });
    expect(m.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
    expect(m.mediaType).toBe(MANIFEST_MEDIA_TYPE);
  });

  it('sorts files by path for deterministic output', () => {
    const m = buildManifest({ files: FILES, cliVersion: '0.0.1' });
    expect(m.files.map((f) => f.path)).toEqual(['a/first.bin', 'middle.bin', 'z/last.bin']);
  });

  it('config carries producer + cliVersion + createdAt', () => {
    const m = buildManifest({
      files: FILES,
      cliVersion: '1.2.3',
      hostname: 'my-laptop',
      platform: 'darwin',
    });
    expect(m.config.producer).toBe('roost-cli');
    expect(m.config.cliVersion).toBe('1.2.3');
    expect(m.config.hostname).toBe('my-laptop');
    expect(m.config.platform).toBe('darwin');
    expect(typeof m.config.createdAt).toBe('string');
  });

  it('merges extra config fields into config', () => {
    const m = buildManifest({
      files: FILES,
      cliVersion: '0.0.1',
      extra: { gitSha: 'abc123', ciJob: '42' },
    });
    expect(m.config.gitSha).toBe('abc123');
    expect(m.config.ciJob).toBe('42');
  });
});

describe('uniqueHashes', () => {
  it('dedups chunk hashes across files', () => {
    const hashes = uniqueHashes(FILES);
    expect(hashes).toHaveLength(2);
    expect(hashes).toContain('h1'.repeat(32));
    expect(hashes).toContain('h2'.repeat(32));
  });
});

describe('summariseManifest', () => {
  it('computes file count, total bytes, total chunks, unique chunks', () => {
    const s = summariseManifest(FILES);
    expect(s.fileCount).toBe(3);
    expect(s.totalBytes).toBe(35);
    expect(s.totalChunks).toBe(3);
    expect(s.uniqueChunks).toBe(2);
  });
});
