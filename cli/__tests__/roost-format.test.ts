import { _internals } from '../src/commands/roost';

const { formatRoostDetail, formatDiff, renderTable, humanBytes, truncate } = _internals;

describe('renderTable', () => {
  it('pads cells + draws a separator row', () => {
    const out = renderTable(
      ['id', 'name'],
      [
        ['rst_12345678', 'alpha'],
        ['rst_00000001', 'b'],
      ],
    );
    const lines = out.trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/id\s+name/);
    expect(lines[1]).toMatch(/^-+\s+-+/);
    expect(lines[2]).toMatch(/rst_12345678\s+alpha/);
  });
});

describe('humanBytes', () => {
  it('converts common magnitudes', () => {
    expect(humanBytes(0)).toBe('0.0 B');
    expect(humanBytes(1023)).toMatch(/B$/);
    expect(humanBytes(1024)).toMatch(/KiB$/);
    expect(humanBytes(1024 * 1024)).toMatch(/MiB$/);
  });

  it('preserves sign for negative values', () => {
    expect(humanBytes(-2048)).toMatch(/^-2\.00 KiB$/);
  });
});

describe('truncate', () => {
  it('elides long strings with an ellipsis', () => {
    expect(truncate('abcdefghij', 5)).toBe('abcde…');
  });
  it('leaves short strings alone', () => {
    expect(truncate('abc', 5)).toBe('abc');
  });
});

describe('formatRoostDetail', () => {
  it('renders the core fields + current version block', () => {
    const out = formatRoostDetail({
      roostId: 'rst_abc',
      siteId: 'site-1',
      name: 'alpha',
      targets: ['m-1', 'm-2'],
      extractPath: '~/Documents/roosts/alpha',
      schemaVersion: 2,
      currentVersionId: 'vrs_01',
      previousVersionId: null,
      versionUrl: 'https://r2/.../vrs_01.json',
      createdAt: '2026-04-22T00:00:00Z',
      updatedAt: '2026-04-22T00:01:00Z',
      deletedAt: null,
      currentVersion: {
        versionId: 'vrs_01',
        versionNumber: 1,
        description: 'initial import',
        versionUrl: 'https://r2/.../vrs_01.json',
        createdAt: '2026-04-22T00:00:00Z',
        createdBy: 'user-1',
        totalSize: 2048,
        totalFiles: 3,
        parentVersionId: null,
      },
      previousVersion: null,
    });
    expect(out).toContain('id         rst_abc');
    expect(out).toContain('name       alpha');
    expect(out).toContain('targets    m-1, m-2');
    expect(out).toContain('current    vrs_01');
    expect(out).toContain('current version:');
    expect(out).toContain('number     #1');
    expect(out).toContain('summary    initial import');
    expect(out).toContain('files      3');
    expect(out).toContain('bytes      2.00 KiB');
  });

  it('marks tombstoned roosts + prints (none) for empty targets', () => {
    const out = formatRoostDetail({
      roostId: 'rst_xyz',
      siteId: 'site-1',
      name: 'deleted',
      targets: [],
      extractPath: null,
      schemaVersion: 2,
      currentVersionId: null,
      previousVersionId: null,
      versionUrl: null,
      createdAt: null,
      updatedAt: null,
      deletedAt: '2026-04-22T00:00:00Z',
      currentVersion: null,
      previousVersion: null,
    });
    expect(out).toContain('targets    (none)');
    expect(out).toContain('deletedAt  2026-04-22T00:00:00Z (tombstoned)');
    expect(out).not.toContain('current version:');
  });
});

describe('formatDiff', () => {
  it('renders added / removed / modified sections', () => {
    const out = formatDiff({
      versionId: 'vrs_new',
      toVersion: 'vrs_new',
      fromVersion: 'vrs_old',
      against: 'vrs_old',
      roostId: 'rst_abc',
      siteId: 'site-1',
      summary: {
        added: 1,
        removed: 1,
        changed: 1,
        unchanged: 0,
        hasChanges: true,
        netBytesDelta: 2048,
      },
      added: [{ path: 'new.bin', size: 1024, reason: 'added', chunks: 1 }],
      removed: [{ path: 'gone.bin', size: 512, reason: 'removed', chunks: 1 }],
      modified: [
        { path: 'edit.bin', fromSize: 2048, toSize: 4096, reason: 'modified', fromChunks: 1, toChunks: 1 },
      ],
    });
    expect(out).toMatch(/diff vrs_old → vrs_new/);
    expect(out).toContain('+ new.bin');
    expect(out).toContain('- gone.bin');
    expect(out).toContain('~ edit.bin');
    expect(out).toContain('2.00 KiB → 4.00 KiB');
  });

  it('notes no-changes when summary is empty', () => {
    const out = formatDiff({
      versionId: 'a',
      toVersion: 'a',
      fromVersion: 'b',
      against: 'b',
      roostId: 'rst',
      siteId: 'site',
      summary: { added: 0, removed: 0, changed: 0, unchanged: 3, hasChanges: false, netBytesDelta: 0 },
      added: [],
      removed: [],
      modified: [],
    });
    expect(out).toContain('(no changes');
  });
});
