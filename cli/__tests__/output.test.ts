import { Command } from 'commander';
import {
  humanBytes,
  isJson,
  renderTable,
  truncate,
} from '../src/lib/output';

describe('humanBytes', () => {
  it('handles small values in B', () => {
    expect(humanBytes(0)).toBe('0.0 B');
    expect(humanBytes(512)).toBe('512.0 B');
  });
  it('switches units at 1024', () => {
    expect(humanBytes(1024)).toMatch(/KiB$/);
    expect(humanBytes(1024 * 1024)).toMatch(/MiB$/);
    expect(humanBytes(1024 ** 3)).toMatch(/GiB$/);
  });
  it('uses 2 decimals under 10 in non-byte units, 1 decimal above', () => {
    expect(humanBytes(2048)).toBe('2.00 KiB');
    expect(humanBytes(12 * 1024)).toBe('12.0 KiB');
  });
  it('preserves sign', () => {
    expect(humanBytes(-2048)).toBe('-2.00 KiB');
  });
});

describe('truncate', () => {
  it('ellipsizes long strings', () => {
    expect(truncate('abcdefghij', 5)).toBe('abcde…');
  });
  it('leaves short strings alone', () => {
    expect(truncate('abc', 5)).toBe('abc');
  });
});

describe('renderTable', () => {
  it('renders headers + separator + rows', () => {
    const out = renderTable(['name', 'age'], [['dylan', '30'], ['a', '1']]);
    const lines = out.trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/name\s+age/);
    expect(lines[1]).toMatch(/^-+\s+-+$/);
  });
  it('handles empty rows with a placeholder', () => {
    expect(renderTable(['a'], [])).toBe('(no rows)\n');
  });
});

describe('isJson', () => {
  it('returns false when --json is not set', () => {
    const program = new Command();
    program.option('--json', 'flag');
    program.parse([], { from: 'user' });
    expect(isJson(program)).toBe(false);
  });
  it('returns true when --json is set', () => {
    const program = new Command();
    program.option('--json', 'flag');
    program.parse(['--json'], { from: 'user' });
    expect(isJson(program)).toBe(true);
  });
});
