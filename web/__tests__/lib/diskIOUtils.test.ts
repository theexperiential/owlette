/** @jest-environment node */

/**
 * Tests for diskIOUtils.ts — per-volume disk IO chart-key helpers + color palette.
 *
 * Verifies: DISK_IO_COLORS shape, formatDiskIO delegation to formatThroughput,
 * isDiskIOKey regex anchoring, parseDiskIOKey id+channel extraction.
 */

import {
  DISK_IO_COLORS,
  formatDiskIO,
  isDiskIOKey,
  parseDiskIOKey,
} from '@/lib/diskIOUtils';
import { formatThroughput } from '@/lib/networkUtils';

describe('DISK_IO_COLORS', () => {
  it('exposes exactly read/write/busy entries', () => {
    expect(Object.keys(DISK_IO_COLORS).sort()).toEqual(['busy', 'read', 'write']);
  });

  it('uses the same green for read as NIC RX (convention parity)', () => {
    expect(DISK_IO_COLORS.read).toBe('rgb(74, 222, 128)');
  });

  it('uses the same orange for write as NIC TX (convention parity)', () => {
    expect(DISK_IO_COLORS.write).toBe('rgb(251, 146, 60)');
  });

  it('uses a distinct purple for busy (not the disk-usage green)', () => {
    expect(DISK_IO_COLORS.busy).toBe('rgb(168, 85, 247)');
  });
});

describe('formatDiskIO', () => {
  // formatDiskIO delegates to formatThroughput — any future divergence is
  // intentional and should surface as a failing test we update together.
  it.each([
    [0],
    [500],
    [1024],
    [1_048_576],          // 1 MiB
    [1_073_741_824],      // 1 GiB
    [1_234_567_890],
  ])('matches formatThroughput(%i)', (v) => {
    expect(formatDiskIO(v)).toBe(formatThroughput(v));
  });
});

describe('isDiskIOKey', () => {
  it('matches the three per-volume channels', () => {
    expect(isDiskIOKey('C:_io_read')).toBe(true);
    expect(isDiskIOKey('C:_io_write')).toBe(true);
    expect(isDiskIOKey('C:_io_busy')).toBe(true);
  });

  it('matches regardless of volume id shape', () => {
    expect(isDiskIOKey('L:_io_read')).toBe(true);
    expect(isDiskIOKey('PhysicalDrive0_io_write')).toBe(true);
    expect(isDiskIOKey('/mnt/data_io_busy')).toBe(true);
  });

  it('rejects the old v1 aggregate keys', () => {
    expect(isDiskIOKey('diskIO_read')).toBe(false);
    expect(isDiskIOKey('diskIO_write')).toBe(false);
    expect(isDiskIOKey('diskIO_busy')).toBe(false);
  });

  it('rejects other per-device patterns', () => {
    expect(isDiskIOKey('Ethernet_tx')).toBe(false);
    expect(isDiskIOKey('Ethernet_rx_util')).toBe(false);
    expect(isDiskIOKey('C:_pct')).toBe(false);
    expect(isDiskIOKey('NVIDIA_usage')).toBe(false);
    expect(isDiskIOKey('NVIDIA_temp')).toBe(false);
  });

  it('rejects invalid channels and empty/garbage', () => {
    expect(isDiskIOKey('')).toBe(false);
    expect(isDiskIOKey('C:_io_')).toBe(false);
    expect(isDiskIOKey('C:_io_latency')).toBe(false);
    expect(isDiskIOKey('_io_read')).toBe(false); // empty id
    expect(isDiskIOKey('C:_io_read_extra')).toBe(false); // suffix-only anchor
  });
});

describe('parseDiskIOKey', () => {
  it('extracts id and channel for each valid channel', () => {
    expect(parseDiskIOKey('C:_io_read')).toEqual({ id: 'C:', channel: 'read' });
    expect(parseDiskIOKey('C:_io_write')).toEqual({ id: 'C:', channel: 'write' });
    expect(parseDiskIOKey('C:_io_busy')).toEqual({ id: 'C:', channel: 'busy' });
  });

  it('handles different volume id shapes', () => {
    expect(parseDiskIOKey('L:_io_read')).toEqual({ id: 'L:', channel: 'read' });
    expect(parseDiskIOKey('PhysicalDrive0_io_write')).toEqual({
      id: 'PhysicalDrive0',
      channel: 'write',
    });
  });

  it('returns null for the old v1 aggregate keys', () => {
    expect(parseDiskIOKey('diskIO_read')).toBeNull();
    expect(parseDiskIOKey('diskIO_write')).toBeNull();
    expect(parseDiskIOKey('diskIO_busy')).toBeNull();
  });

  it('returns null for non-disk-IO keys', () => {
    expect(parseDiskIOKey('Ethernet_tx')).toBeNull();
    expect(parseDiskIOKey('C:_pct')).toBeNull();
    expect(parseDiskIOKey('NVIDIA_usage')).toBeNull();
  });

  it('returns null for garbage', () => {
    expect(parseDiskIOKey('')).toBeNull();
    expect(parseDiskIOKey('foo')).toBeNull();
    expect(parseDiskIOKey('C:_io_')).toBeNull();
    expect(parseDiskIOKey('C:_io_latency')).toBeNull();
    expect(parseDiskIOKey('_io_read')).toBeNull();
  });

  it('narrows the channel return type to the literal union', () => {
    const parsed = parseDiskIOKey('C:_io_write');
    // If the cast in parseDiskIOKey is wrong this test fails at compile time.
    if (parsed) {
      const channel: 'read' | 'write' | 'busy' = parsed.channel;
      expect(channel).toBe('write');
    }
  });
});
