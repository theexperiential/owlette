/** @jest-environment node */

/**
 * Tests for networkUtils.ts — throughput formatting rules. The unit-promotion
 * and trailing-".0" trim behavior is easy to regress, so pin them here.
 */

import { formatThroughput } from '@/lib/networkUtils';

describe('formatThroughput', () => {
  it('rounds sub-KB values to whole bytes', () => {
    expect(formatThroughput(0)).toBe('0 B/s');
    expect(formatThroughput(1)).toBe('1 B/s');
    expect(formatThroughput(499.4)).toBe('499 B/s');
    expect(formatThroughput(1023)).toBe('1023 B/s');
  });

  it('trims trailing ".0" for whole-unit values', () => {
    expect(formatThroughput(1024)).toBe('1 KB/s');
    expect(formatThroughput(256_000)).toBe('250 KB/s');
    expect(formatThroughput(512_000)).toBe('500 KB/s');
    expect(formatThroughput(1_048_576)).toBe('1 MB/s');
    expect(formatThroughput(2_097_152)).toBe('2 MB/s');
    expect(formatThroughput(1_073_741_824)).toBe('1 GB/s');
  });

  it('keeps a single decimal for non-whole values', () => {
    expect(formatThroughput(1536)).toBe('1.5 KB/s');
    expect(formatThroughput(1_536_000)).toBe('1.5 MB/s');
    expect(formatThroughput(5_368_709_120 * 1.5)).toBe('7.5 GB/s');
  });

  it('promotes to the next unit at 1000 rather than 1024', () => {
    // 1000 KB (= 1_024_000 bytes) must read as "1 MB/s", not "1000 KB/s".
    expect(formatThroughput(1_024_000)).toBe('1 MB/s');
    // Just under 1000 KB (rounded to 1dp) stays in KB.
    expect(formatThroughput(999 * 1024)).toBe('999 KB/s');
    // Same rule at the MB→GB boundary.
    expect(formatThroughput(1000 * 1_048_576)).toBe('1 GB/s');
  });

  it('handles the rounding edge at 999.95 KB/s', () => {
    // toFixed(1) would render "1000.0 KB/s" — must promote to MB.
    expect(formatThroughput(999.95 * 1024)).toBe('1 MB/s');
  });
});
