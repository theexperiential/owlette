/**
 * @jest-environment node
 *
 * tests for web/lib/preUploadCheck.ts
 */

import type { NamedBlob, VersionFileEntry } from '@/lib/chunking';
import {
  canStartUpload,
  checkQuota,
  checkTargetDisks,
  DEFAULT_UPLOAD_MBPS,
  estimateUploadSeconds,
  formatBytes,
  formatDuration,
  summariseRawFiles,
  summariseSize,
  type PreUploadTarget,
} from '@/lib/preUploadCheck';

const MB = 1024 * 1024;
const GB = 1024 ** 3;

function entry(path: string, chunks: Array<{ hash: string; size: number }>): VersionFileEntry {
  const size = chunks.reduce((n, c) => n + c.size, 0);
  return { path, size, chunks };
}

describe('summariseSize', () => {
  it('zero entries → zeros, no NaN', () => {
    const s = summariseSize([]);
    expect(s.fileCount).toBe(0);
    expect(s.totalBytes).toBe(0);
    expect(s.uploadBytes).toBe(0);
    expect(s.dedupRatio).toBe(0);
  });

  it('no dedup: uploadBytes equals totalBytes', () => {
    const s = summariseSize([
      entry('a', [{ hash: 'h1', size: 100 }]),
      entry('b', [{ hash: 'h2', size: 200 }]),
    ]);
    expect(s.totalBytes).toBe(300);
    expect(s.uploadBytes).toBe(300);
    expect(s.dedupRatio).toBe(0);
  });

  it('chunk-level dedup collapses duplicate hashes to one copy', () => {
    const s = summariseSize([
      entry('a', [{ hash: 'same', size: 100 }]),
      entry('b', [{ hash: 'same', size: 100 }]),
    ]);
    expect(s.totalBytes).toBe(200);
    expect(s.uploadBytes).toBe(100);
    expect(s.dedupRatio).toBe(0.5);
  });

  it('`alreadyPresent` set excludes chunks already on server', () => {
    const s = summariseSize(
      [
        entry('a', [{ hash: 'new', size: 100 }]),
        entry('b', [{ hash: 'existing', size: 200 }]),
      ],
      new Set(['existing']),
    );
    expect(s.totalBytes).toBe(300);
    expect(s.uploadBytes).toBe(100);
  });

  it('dedupRatio=0 when totalBytes is 0 (guard against /0)', () => {
    const s = summariseSize([]);
    expect(s.dedupRatio).toBe(0);
  });
});

function rawFile(path: string, size: number): NamedBlob {
  return { path, blob: { size } as unknown as Blob };
}

describe('summariseRawFiles', () => {
  it('zero files → zeros, no NaN', () => {
    const s = summariseRawFiles([]);
    expect(s.fileCount).toBe(0);
    expect(s.totalBytes).toBe(0);
    expect(s.uploadBytes).toBe(0);
    expect(s.dedupRatio).toBe(0);
  });

  it('sums blob sizes for fileCount + totalBytes', () => {
    const s = summariseRawFiles([
      rawFile('a.toe', 4 * MB),
      rawFile('b.toe', 8 * MB),
      rawFile('c/d.toe', 2 * MB),
    ]);
    expect(s.fileCount).toBe(3);
    expect(s.totalBytes).toBe(14 * MB);
  });

  it('uploadBytes equals totalBytes (no dedup pre-hash)', () => {
    // Pre-hash, overlap is unknowable — show worst case so the confirm screen
    // never understates what goes over the wire.
    const s = summariseRawFiles([
      rawFile('a.toe', 4 * MB),
      rawFile('b.toe', 4 * MB),
    ]);
    expect(s.uploadBytes).toBe(s.totalBytes);
    expect(s.dedupRatio).toBe(0);
  });
});

describe('estimateUploadSeconds', () => {
  it('returns 0 for a 0-byte upload', () => {
    expect(estimateUploadSeconds(0)).toBe(0);
  });

  it('≈13 seconds for 100 MB at 50 Mbps (incl 30% overhead)', () => {
    // 800 Mb / 50 Mbps = 16s, ×1.3 overhead ≈ 21s.
    const s = estimateUploadSeconds(100 * MB, 50);
    expect(s).toBeGreaterThan(18);
    expect(s).toBeLessThan(24);
  });

  it('scales inversely with bandwidth', () => {
    const slow = estimateUploadSeconds(100 * MB, 10);
    const fast = estimateUploadSeconds(100 * MB, 100);
    expect(slow).toBeGreaterThan(fast * 5);
  });

  it('falls back to DEFAULT_UPLOAD_MBPS on non-positive mbps', () => {
    const withDefault = estimateUploadSeconds(100 * MB);
    const explicit = estimateUploadSeconds(100 * MB, DEFAULT_UPLOAD_MBPS);
    expect(withDefault).toBe(explicit);
    expect(estimateUploadSeconds(100 * MB, 0)).toBe(explicit);
    expect(estimateUploadSeconds(100 * MB, -50)).toBe(explicit);
  });

  it('never returns a fractional or zero duration for any positive upload', () => {
    // 1 byte still reads as 1s — nicer copy than "< 1s".
    expect(estimateUploadSeconds(1)).toBeGreaterThanOrEqual(1);
  });
});

describe('formatDuration', () => {
  it('seconds for <60s', () => {
    expect(formatDuration(42)).toMatch(/42 sec/);
  });
  it('minutes for <3600s', () => {
    expect(formatDuration(300)).toMatch(/5 min/);
  });
  it('hours for ≥3600s, decimal under 10', () => {
    expect(formatDuration(9_000)).toMatch(/2\.5 hr/);
  });
  it('hours for ≥36000s, rounded when ≥10', () => {
    expect(formatDuration(50_000)).toMatch(/^14 hr$/);
  });
});

function target(name: string, freeDiskBytes?: number): PreUploadTarget {
  return { machineId: name, name, freeDiskBytes };
}

describe('checkTargetDisks', () => {
  it('no warnings when every target has plenty of room', () => {
    const checks = checkTargetDisks(
      [target('a', 100 * GB), target('b', 100 * GB)],
      1 * GB,
    );
    expect(checks.length).toBe(0);
  });

  it('error when target free < totalBytes × (1+margin)', () => {
    // 1 GB + 20% margin = 1.2 GB required; the target has 1.1 GB.
    const checks = checkTargetDisks([target('tight', 1.1 * GB)], 1 * GB);
    expect(checks.length).toBe(1);
    expect(checks[0].severity).toBe('error');
    expect(checks[0].blocking).toBe(true);
    expect(checks[0].message).toMatch(/tight/);
  });

  it('custom margin overrides default', () => {
    const relaxed = checkTargetDisks([target('ok', 1.1 * GB)], 1 * GB, 0);
    expect(relaxed.length).toBe(0);
    const strict = checkTargetDisks([target('ok', 1.1 * GB)], 1 * GB, 0.5);
    expect(strict.length).toBe(1);
  });

  it('non-blocking warning when free disk is unknown', () => {
    const checks = checkTargetDisks([target('unknown')], 1 * GB);
    expect(checks.length).toBe(1);
    expect(checks[0].severity).toBe('warning');
    expect(checks[0].blocking).toBe(false);
  });

  it('mixes warnings + errors when some targets known, some not', () => {
    const checks = checkTargetDisks(
      [target('unknown'), target('full', 0), target('fine', 100 * GB)],
      1 * GB,
    );
    expect(checks.length).toBe(2); // unknown + full; "fine" is omitted
    const severities = checks.map((c) => c.severity);
    expect(severities).toContain('warning');
    expect(severities).toContain('error');
  });
});

describe('checkQuota', () => {
  it('returns null when quota is undefined', () => {
    expect(checkQuota(1 * GB, undefined)).toBeNull();
  });

  it('returns null when well under threshold', () => {
    // 2 GB of a 5 GB plan — under the 80% line.
    expect(
      checkQuota(1 * GB, {
        planLimitBytes: 5 * GB,
        usedBytes: 1 * GB,
        pendingBytes: 0,
        roostAvailable: true,
      }),
    ).toBeNull();
  });

  it('warning when crossing 80% of the plan', () => {
    // 4.5 GB of a 5 GB plan = 90%.
    const c = checkQuota(1 * GB, {
      planLimitBytes: 5 * GB,
      usedBytes: 3.5 * GB,
      pendingBytes: 0,
      roostAvailable: true,
    });
    expect(c).not.toBeNull();
    expect(c!.severity).toBe('warning');
    expect(c!.blocking).toBe(false);
  });

  it('blocking error when upload would exceed plan', () => {
    // 6 GB against a 5 GB plan.
    const c = checkQuota(2 * GB, {
      planLimitBytes: 5 * GB,
      usedBytes: 4 * GB,
      pendingBytes: 0,
      roostAvailable: true,
    });
    expect(c).not.toBeNull();
    expect(c!.severity).toBe('error');
    expect(c!.blocking).toBe(true);
    expect(c!.message).toMatch(/exceed/i);
  });

  it('counts pendingBytes toward the total (concurrent upload protection)', () => {
    // 4 GB used + 1 GB pending is already the cap.
    const c = checkQuota(1 * GB, {
      planLimitBytes: 5 * GB,
      usedBytes: 4 * GB,
      pendingBytes: 1 * GB,
      roostAvailable: true,
    });
    expect(c?.severity).toBe('error');
  });
});

describe('canStartUpload', () => {
  it('true when no checks', () => {
    expect(canStartUpload([])).toBe(true);
  });

  it('true when only non-blocking warnings', () => {
    expect(
      canStartUpload([
        { blocking: false, severity: 'warning', message: 'heads up' },
      ]),
    ).toBe(true);
  });

  it('false when any blocking check present', () => {
    expect(
      canStartUpload([
        { blocking: false, severity: 'warning', message: 'soft' },
        { blocking: true, severity: 'error', message: 'hard' },
      ]),
    ).toBe(false);
  });
});

describe('formatBytes', () => {
  it('formats common sizes', () => {
    expect(formatBytes(0)).toMatch(/^0 B$/);
    expect(formatBytes(500)).toMatch(/^500 B$/);
    expect(formatBytes(2 * 1024)).toMatch(/^2 KB$/);
    expect(formatBytes(3 * 1024 * 1024)).toMatch(/^3 MB$/);
    expect(formatBytes(1.5 * GB)).toMatch(/^1\.5 GB$/);
    expect(formatBytes(3 * 1024 ** 4)).toMatch(/^3\.00 TB$/);
  });

  it('returns em-dash for invalid inputs', () => {
    expect(formatBytes(NaN)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
  });
});
