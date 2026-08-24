/**
 * Guard for log forging.
 *
 * Machine names, process names, chat ids and nonces reach `console.*` template
 * literals from request bodies and agent registration. A newline in any of them
 * lets its author append a fresh, well-formed-looking log line — the reason
 * CodeQL flags `js/log-injection` across the hoot routes.
 */

import { MAX_LOG_FIELD_LENGTH, sanitizeForLog } from '@/lib/logSanitize';

describe('sanitizeForLog', () => {
  it('defuses a forged log line', () => {
    const forged = 'ok\n2026-01-01 [INFO] admin granted superadmin';
    const out = sanitizeForLog(forged);

    expect(out).not.toContain('\n');
    // Flattened, not deleted: the injected text must stay visible so a reader
    // can see what was attempted rather than it silently joining the line.
    expect(out).toBe('ok\\n2026-01-01 [INFO] admin granted superadmin');
  });

  it('flattens CR, LF and CRLF alike', () => {
    expect(sanitizeForLog('a\rb')).toBe('a\\nb');
    expect(sanitizeForLog('a\nb')).toBe('a\\nb');
    expect(sanitizeForLog('a\r\nb')).toBe('a\\nb');
  });

  it('strips C0 and C1 control characters', () => {
    expect(sanitizeForLog('a\u0000b')).toBe('ab');
    expect(sanitizeForLog('a\u007Fb')).toBe('ab');
    // ESC would otherwise let a value emit terminal escape sequences.
    expect(sanitizeForLog('a\u001B[31mred')).toBe('a[31mred');
  });

  it('leaves ordinary text untouched', () => {
    expect(sanitizeForLog('TD-WALL-01 / TouchDesigner.exe')).toBe(
      'TD-WALL-01 / TouchDesigner.exe',
    );
  });

  it('caps a pathological value so it cannot flood the log', () => {
    const out = sanitizeForLog('x'.repeat(MAX_LOG_FIELD_LENGTH + 400));
    expect(out.startsWith('x'.repeat(MAX_LOG_FIELD_LENGTH))).toBe(true);
    expect(out.endsWith('...[truncated]')).toBe(true);
    expect(out.length).toBe(MAX_LOG_FIELD_LENGTH + '...[truncated]'.length);
  });

  it('does not truncate a value at the limit', () => {
    const exact = 'y'.repeat(MAX_LOG_FIELD_LENGTH);
    expect(sanitizeForLog(exact)).toBe(exact);
  });

  it('stringifies non-strings so call sites need no cast', () => {
    expect(sanitizeForLog(42)).toBe('42');
    expect(sanitizeForLog(undefined)).toBe('undefined');
    expect(sanitizeForLog(new Error('boom\nforged'))).toBe('Error: boom\\nforged');
  });
});
