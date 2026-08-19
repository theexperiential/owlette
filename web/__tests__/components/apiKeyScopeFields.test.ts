import {
  customScopesForSelection,
  presetForScopes,
  resolveScopes,
  validateScopeSelection,
} from '@/components/ApiKeyScopeFields';
import { SCOPE_PRESETS, type ApiKeyScope } from '@/lib/apiKeyTypes';

/**
 * The pure half of the shared scope builder.
 *
 * presetForScopes is the piece with a real failure mode: the editor calls it to
 * decide whether a key reopens on the preset it was minted from or falls into
 * the sixteen-checkbox custom builder. Getting it wrong silently converts every
 * edited preset key into a custom one.
 */

describe('presetForScopes', () => {
  it.each(Object.keys(SCOPE_PRESETS) as (keyof typeof SCOPE_PRESETS)[])(
    'recognises the %s preset from its expanded scopes',
    (preset) => {
      expect(presetForScopes(SCOPE_PRESETS[preset])).toBe(preset);
    },
  );

  it('matches regardless of scope or permission ordering', () => {
    const shuffled = [...SCOPE_PRESETS.publisher]
      .reverse()
      .map((s) => ({ ...s, permissions: [...s.permissions].reverse() }));
    expect(presetForScopes(shuffled)).toBe('publisher');
  });

  it('falls back to custom when a preset is one permission off', () => {
    const nearlyPublisher = SCOPE_PRESETS.publisher.map((s, i) =>
      i === 0 ? { ...s, permissions: ['read' as const] } : s,
    );
    expect(presetForScopes(nearlyPublisher)).toBe('custom');
  });

  it('falls back to custom when a preset has an extra scope', () => {
    const widened: ApiKeyScope[] = [
      ...SCOPE_PRESETS.readonly,
      { resource: 'installer', id: '*', permissions: ['write'] },
    ];
    expect(presetForScopes(widened)).toBe('custom');
  });

  it('treats a legacy key with no scopes as custom', () => {
    expect(presetForScopes(null)).toBe('custom');
    expect(presetForScopes([])).toBe('custom');
  });
});

describe('resolveScopes', () => {
  it('expands a preset and ignores whatever is in the custom builder', () => {
    const custom: ApiKeyScope[] = [{ resource: 'site', id: 'abc', permissions: ['admin'] }];
    expect(resolveScopes('operator', custom)).toEqual(SCOPE_PRESETS.operator);
  });

  it('passes custom scopes through untouched', () => {
    const custom: ApiKeyScope[] = [{ resource: 'installer', id: '*', permissions: ['write'] }];
    expect(resolveScopes('custom', custom)).toEqual(custom);
  });
});

describe('validateScopeSelection', () => {
  it('never blocks a preset, even with an empty custom builder', () => {
    expect(validateScopeSelection('publisher', [])).toBeNull();
  });

  it('rejects an empty custom scope list', () => {
    expect(validateScopeSelection('custom', [])).toBe('add at least one scope');
  });

  it('rejects a blank id, naming the offending row', () => {
    expect(
      validateScopeSelection('custom', [{ resource: 'site', id: '  ', permissions: ['read'] }]),
    ).toBe('scope 1: id is required (use * for all)');
  });

  it('rejects a scope with no permissions checked', () => {
    expect(
      validateScopeSelection('custom', [
        { resource: 'site', id: '*', permissions: ['read'] },
        { resource: 'machine', id: '*', permissions: [] },
      ]),
    ).toBe('scope 2: pick at least one permission');
  });

  it('accepts a well-formed custom selection', () => {
    expect(
      validateScopeSelection('custom', [
        { resource: 'installer', id: '*', permissions: ['read', 'write'] },
      ]),
    ).toBeNull();
  });
});

describe('customScopesForSelection', () => {
  const grants = (scopes: ApiKeyScope[]) =>
    scopes.reduce((n, s) => n + s.permissions.length, 0);

  it('carries the selected preset into the builder (regression: preset->custom scope loss)', () => {
    const seeded = customScopesForSelection('custom', 'operator', [
      { resource: 'site', id: '*', permissions: ['read', 'write'] },
    ]);
    expect(seeded).toEqual(SCOPE_PRESETS.operator);
    expect(grants(seeded!)).toBe(16);
  });

  /**
   * NEGATIVE CONTROL — this is the behaviour shipping today.
   *
   * The builder opened on a hardcoded literal regardless of the preset in
   * effect, so the switch dropped 3 of 4 resources and 14 of 16 grants. It
   * passed validateScopeSelection, validateScopes and assertScopesGrantable,
   * and POST /api/keys returned 200 with scopeCount 1.
   */
  it('the old behaviour opened on one unrelated row, losing 14 of 16 grants', () => {
    const OLD_SEED: ApiKeyScope[] = [
      { resource: 'site', id: '*', permissions: ['read', 'write'] },
    ];
    expect(grants(resolveScopes('operator', OLD_SEED))).toBe(16);
    expect(grants(resolveScopes('custom', OLD_SEED))).toBe(2);
    expect(resolveScopes('custom', OLD_SEED)).toHaveLength(1);
  });

  it('leaves the builder alone when the user is already in custom', () => {
    const edited: ApiKeyScope[] = [
      { resource: 'installer', id: '*', permissions: ['write'] },
    ];
    // Re-seeding here would discard work in progress on every re-render.
    expect(customScopesForSelection('custom', 'custom', edited)).toBeNull();
  });

  it('does nothing when moving between named presets', () => {
    expect(customScopesForSelection('admin', 'operator', [])).toBeNull();
  });

  it('copies the preset rather than handing over the shared singleton', () => {
    const seeded = customScopesForSelection('custom', 'publisher', [])!;
    seeded[0].permissions.push('admin');
    // wildcardScopes assigns ONE permissions array to all four rows of a
    // preset, so a shallow hand-off would corrupt the constant for the tab.
    expect(SCOPE_PRESETS.publisher[0].permissions).toEqual(['read', 'write']);
  });

  it('seeds the editor from the preset just picked, not the key it opened on', () => {
    // The editor's own version of the bug: a publisher key, user picks
    // operator, then custom — and was shown the original publisher rows,
    // silently reverting the choice they had just made.
    const keyScopes = SCOPE_PRESETS.publisher;
    expect(customScopesForSelection('custom', 'operator', keyScopes)).toEqual(
      SCOPE_PRESETS.operator,
    );
  });
});
