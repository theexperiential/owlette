import {
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
