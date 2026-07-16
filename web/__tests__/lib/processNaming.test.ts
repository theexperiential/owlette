/** @jest-environment node */

/**
 * Tests for processNaming.ts — the duplicate-name suffixing rule that keeps a
 * cloned process from colliding with an existing name (the server rejects
 * duplicates with 409). The case-insensitive matching is easy to regress, so
 * pin it here.
 */

import { nextDuplicateName } from '@/lib/processNaming';

describe('nextDuplicateName', () => {
  it('appends " (copy)" when the base name has no copies yet', () => {
    expect(nextDuplicateName('TouchDesigner', [])).toBe('TouchDesigner (copy)');
    expect(nextDuplicateName('TouchDesigner', ['TouchDesigner'])).toBe('TouchDesigner (copy)');
  });

  it('increments the suffix when earlier copies exist', () => {
    expect(nextDuplicateName('Kiosk', ['Kiosk', 'Kiosk (copy)'])).toBe('Kiosk (copy 2)');
    expect(
      nextDuplicateName('Kiosk', ['Kiosk', 'Kiosk (copy)', 'Kiosk (copy 2)']),
    ).toBe('Kiosk (copy 3)');
  });

  it('skips gaps and returns the first free suffix', () => {
    // "(copy)" is free even though "(copy 2)" is taken.
    expect(nextDuplicateName('Signage', ['Signage (copy 2)'])).toBe('Signage (copy)');
  });

  it('matches existing names case-insensitively', () => {
    expect(nextDuplicateName('Media', ['media (copy)'])).toBe('Media (copy 2)');
    expect(nextDuplicateName('MEDIA', ['media', 'media (copy)'])).toBe('MEDIA (copy 2)');
  });

  it('preserves the base name casing and surrounding whitespace', () => {
    expect(nextDuplicateName('My App', [])).toBe('My App (copy)');
  });
});
