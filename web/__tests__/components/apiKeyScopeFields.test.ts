import {
  applyPreset,
  buildScopeRows,
  presetForScopes,
  type ScopeRow,
  serializeScopeRows,
  summarizeScopeDiff,
  validateScopeRows,
} from '@/components/ApiKeyScopeFields';
import { SCOPE_PRESETS, type ApiKeyScope } from '@/lib/apiKeyTypes';

/**
 * The pure half of the shared scope builder.
 *
 * presetForScopes is the load-bearing one: it decides the live pressed-state of
 * the preset chips on every keystroke. Getting it wrong makes the UI claim a
 * key is `publisher` when it is not, or vice versa.
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

describe('buildScopeRows / serializeScopeRows', () => {
  it('round-trips a preset byte-identically, so the POST body is unchanged', () => {
    const rows = buildScopeRows(SCOPE_PRESETS.publisher, true);
    expect(serializeScopeRows(rows)).toEqual(SCOPE_PRESETS.publisher);
    // And the chip still recognises it, so a preset key is never silently
    // converted to a custom one just by opening the editor.
    expect(presetForScopes(serializeScopeRows(rows))).toBe('publisher');
  });

  it('gives every grantable resource a row, ticked or not', () => {
    const rows = buildScopeRows(SCOPE_PRESETS.readonly, true);
    expect(rows.map((r) => r.resource)).toEqual([
      'roost',
      'site',
      'machine',
      'chat',
      'deploy',
      'process',
      'user',
      'installer',
    ]);
    // The four the preset covers are ticked; the rest are present but empty —
    // that is what makes installer reachable without a mode switch.
    expect(rows.filter((r) => r.permissions.length > 0)).toHaveLength(4);
    expect(rows.find((r) => r.resource === 'installer')?.permissions).toEqual([]);
  });

  it('omits the platform rows entirely for a non-superadmin', () => {
    const rows = buildScopeRows(SCOPE_PRESETS.publisher, false);
    expect(rows.some((r) => r.resource === 'user' || r.resource === 'installer')).toBe(false);
  });

  it('drops an empty row rather than emitting a scope with no permissions', () => {
    const rows = buildScopeRows([], true);
    expect(serializeScopeRows(rows)).toEqual([]);
  });

  it('keeps a specific id as its own row, beneath its wildcard row', () => {
    const rows = buildScopeRows(
      [
        { resource: 'site', id: '*', permissions: ['read'] },
        { resource: 'site', id: 'ohio-lobby', permissions: ['read', 'write'] },
      ],
      false,
    );
    const siteRows = rows.filter((r) => r.resource === 'site');
    expect(siteRows.map((r) => r.kind)).toEqual(['base', 'specific']);
    expect(serializeScopeRows(rows)).toEqual([
      { resource: 'site', id: '*', permissions: ['read'] },
      { resource: 'site', id: 'ohio-lobby', permissions: ['read', 'write'] },
    ]);
  });

  it('locks a platform grant the viewer can no longer re-grant, and drops it on save', () => {
    const rows = buildScopeRows(
      [{ resource: 'installer', id: '*', permissions: ['read', 'write'] }],
      false,
    );
    const locked = rows.find((r) => r.kind === 'locked');
    expect(locked?.resource).toBe('installer');
    // Excluded from the wire array: assertScopesGrantable rejects the resource
    // outright for a non-superadmin without diffing, so submitting it would 403
    // the whole request — including a rename. The banner discloses the loss.
    expect(serializeScopeRows(rows)).toEqual([]);
  });

  it('does not emit a half-built specific row, so the counter stays honest', () => {
    const rows: ScopeRow[] = [
      { resource: 'site', id: '*', permissions: ['read'], kind: 'base' },
      { resource: 'site', id: '   ', permissions: ['read'], kind: 'specific' },
    ];
    expect(serializeScopeRows(rows)).toEqual([
      { resource: 'site', id: '*', permissions: ['read'] },
    ]);
  });
});

describe('applyPreset', () => {
  it('writes the preset into the table (regression: create-form scope loss)', () => {
    const rows = buildScopeRows(SCOPE_PRESETS.publisher, false);
    const after = serializeScopeRows(applyPreset('operator', rows));
    expect(after).toEqual(SCOPE_PRESETS.operator);
    expect(presetForScopes(after)).toBe('operator');
  });

  /**
   * NEGATIVE CONTROL for the above.
   *
   * The old component held a `preset` plus a `customScopes` array hardcoded to
   * one site row, and resolveScopes ignored the builder whenever a named preset
   * was selected. Reimplemented inline here because the guard is worthless
   * unless the behaviour it forbids is shown to fail: a DOM-level control is
   * impossible across this redesign (the old affordance was a Radix SelectItem
   * in a portal, so a new locator would simply miss, which proves nothing).
   */
  it('the old two-state model loses 14 of 16 grants on the same transition', () => {
    const oldResolve = (preset: 'operator' | 'custom', custom: ApiKeyScope[]) =>
      preset === 'custom' ? custom : SCOPE_PRESETS[preset];
    const OLD_SEED: ApiKeyScope[] = [
      { resource: 'site', id: '*', permissions: ['read', 'write'] },
    ];

    const grants = (scopes: ApiKeyScope[]) =>
      scopes.reduce((n, s) => n + s.permissions.length, 0);

    // Pick operator: 4 scopes, 16 grants.
    expect(grants(oldResolve('operator', OLD_SEED))).toBe(16);
    // Then pick custom to add one thing — and silently keep 2.
    expect(grants(oldResolve('custom', OLD_SEED))).toBe(2);

    // The new model, same transition, loses nothing.
    const rows = buildScopeRows(SCOPE_PRESETS.publisher, false);
    expect(grants(serializeScopeRows(applyPreset('operator', rows)))).toBe(16);
  });

  it('discards specific rows so the chip cannot claim a preset it does not hold', () => {
    const rows = buildScopeRows(
      [
        { resource: 'site', id: '*', permissions: ['read'] },
        { resource: 'site', id: 'ohio-lobby', permissions: ['admin'] },
      ],
      false,
    );
    const after = applyPreset('readonly', rows);
    expect(after.some((r) => r.kind === 'specific')).toBe(false);
    expect(presetForScopes(serializeScopeRows(after))).toBe('readonly');
  });

  it('preserves a locked row — it is a fact about the key, not a selection', () => {
    const rows = buildScopeRows(
      [{ resource: 'installer', id: '*', permissions: ['write'] }],
      false,
    );
    const after = applyPreset('publisher', rows);
    expect(after.find((r) => r.kind === 'locked')?.permissions).toEqual(['write']);
  });

  it('does not mutate the SCOPE_PRESETS singletons', () => {
    const before = JSON.stringify(SCOPE_PRESETS.operator);
    const rows = applyPreset('operator', buildScopeRows(null, false));
    rows[0].permissions.push('admin');
    expect(JSON.stringify(SCOPE_PRESETS.operator)).toBe(before);
  });
});

describe('validateScopeRows', () => {
  it('rejects a grid with nothing ticked', () => {
    expect(validateScopeRows(buildScopeRows(null, false))).toBe('add at least one scope');
  });

  it('names the row when a specific id was never typed', () => {
    const rows: ScopeRow[] = [
      { resource: 'site', id: '  ', permissions: ['read'], kind: 'specific' },
    ];
    expect(validateScopeRows(rows)).toBe('all sites: enter an id, or remove the row');
  });

  it('refuses a typed "*" instead of silently merging it into the base row', () => {
    const rows: ScopeRow[] = [
      { resource: 'site', id: '*', permissions: ['read'], kind: 'base' },
      { resource: 'site', id: '*', permissions: ['write'], kind: 'specific' },
    ];
    // The server validator is shape-only and would persist both, pinning the
    // chip to 'custom' forever.
    expect(validateScopeRows(rows)).toBe('use the "all sites" row instead of an id of *');
  });

  it('rejects an explicitly added row left with no permissions', () => {
    const rows: ScopeRow[] = [
      { resource: 'site', id: '*', permissions: ['read'], kind: 'base' },
      { resource: 'site', id: 'ohio-lobby', permissions: [], kind: 'specific' },
    ];
    expect(validateScopeRows(rows)).toBe('site ohio-lobby: pick at least one permission');
  });

  it('accepts a well-formed grid', () => {
    expect(validateScopeRows(buildScopeRows(SCOPE_PRESETS.publisher, true))).toBeNull();
  });

  it('accepts a grid holding only a platform grant', () => {
    const rows = buildScopeRows(
      [{ resource: 'installer', id: '*', permissions: ['read', 'write'] }],
      true,
    );
    expect(validateScopeRows(rows)).toBeNull();
  });
});

describe('summarizeScopeDiff', () => {
  it('reports a widening in terms of what it adds', () => {
    const diff = summarizeScopeDiff(SCOPE_PRESETS.publisher, SCOPE_PRESETS.operator);
    expect(diff.added).toContain('adds deploy, rollback on all sites');
    expect(diff.removed).toEqual([]);
  });

  it('reports a narrowing in terms of what it removes', () => {
    const diff = summarizeScopeDiff(SCOPE_PRESETS.operator, SCOPE_PRESETS.publisher);
    expect(diff.removed).toContain('removes deploy, rollback on all machines');
    expect(diff.added).toEqual([]);
  });

  it('names a specific id rather than calling it "all"', () => {
    const diff = summarizeScopeDiff(
      [],
      [{ resource: 'site', id: 'ohio-lobby', permissions: ['read'] }],
    );
    expect(diff.added).toEqual(['adds read on site ohio-lobby']);
  });

  it('treats a legacy key as added-only', () => {
    const diff = summarizeScopeDiff(null, SCOPE_PRESETS.readonly);
    expect(diff.removed).toEqual([]);
    expect(diff.added).toHaveLength(4);
  });

  it('says nothing when nothing changed', () => {
    const diff = summarizeScopeDiff(SCOPE_PRESETS.admin, SCOPE_PRESETS.admin);
    expect(diff).toEqual({ added: [], removed: [] });
  });
});
