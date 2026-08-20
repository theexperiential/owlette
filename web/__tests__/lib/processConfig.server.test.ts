/**
 * assertNoNewDuplicateNames — the txn-time duplicate-name gate.
 *
 * The field scenario that motivated the before/after form: agent-synced configs
 * can arrive with duplicate names already in them (the desktop app never
 * validated names), and a whole-array uniqueness check made every subsequent
 * save on that machine fail with 409 — including the renames that would have
 * cleaned the duplicates up.
 */
import { assertNoNewDuplicateNames } from '@/lib/processConfig.server';

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: jest.fn(),
}));

describe('assertNoNewDuplicateNames', () => {
  const SEVEN_UNTITLED = Array(7).fill('untitled process');

  it('allows a rename that touches nothing else while pre-existing duplicates persist', () => {
    const before = ['touch', 'node.js', ...SEVEN_UNTITLED];
    const after = ['touchyy', 'node.js', ...SEVEN_UNTITLED];
    expect(() => assertNoNewDuplicateNames(before, after)).not.toThrow();
  });

  it('rejects a rename that collides with an existing name', () => {
    const before = ['touch', 'node.js'];
    const after = ['node.js', 'node.js'];
    expect(() => assertNoNewDuplicateNames(before, after)).toThrow(
      'Duplicate process name: node.js'
    );
  });

  it('rejects a create that collides with an existing name', () => {
    const before = ['touch'];
    const after = ['touch', 'touch'];
    expect(() => assertNoNewDuplicateNames(before, after)).toThrow(
      'Duplicate process name: touch'
    );
  });

  it('rejects joining an existing collision (7 untitled -> 8)', () => {
    const before = ['touch', ...SEVEN_UNTITLED];
    const after = ['untitled process', ...SEVEN_UNTITLED];
    expect(() => assertNoNewDuplicateNames(before, after)).toThrow(
      'Duplicate process name: untitled process'
    );
  });

  it('allows cleanup that shrinks a collision without resolving it fully (7 -> 6)', () => {
    const before = [...SEVEN_UNTITLED];
    const after = ['renamed one', ...Array(6).fill('untitled process')];
    expect(() => assertNoNewDuplicateNames(before, after)).not.toThrow();
  });

  it('allows deleting one entry of a collision', () => {
    const before = ['touch', ...SEVEN_UNTITLED];
    const after = ['touch', ...Array(6).fill('untitled process')];
    expect(() => assertNoNewDuplicateNames(before, after)).not.toThrow();
  });

  it('is case-sensitive, matching agent behaviour', () => {
    const before = ['touch'];
    const after = ['touch', 'Touch'];
    expect(() => assertNoNewDuplicateNames(before, after)).not.toThrow();
  });

  it('ignores nameless entries', () => {
    const before = ['touch', undefined, undefined];
    const after = ['touch', undefined, undefined, undefined];
    expect(() => assertNoNewDuplicateNames(before, after)).not.toThrow();
  });
});
