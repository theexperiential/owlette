/**
 * Tests for BUILT_IN_PROJECT_DISTRIBUTION_PRESETS
 *
 * These presets are merged client-side into the preset list. Validating the
 * shape here catches accidental regressions (missing fields, empty names,
 * malformed paths) that would only surface at runtime otherwise.
 */

import {
  BUILT_IN_PROJECT_DISTRIBUTION_PRESETS,
  type ProjectDistributionPresetDefinition,
} from '@/lib/projectDistributionDefaults';

describe('BUILT_IN_PROJECT_DISTRIBUTION_PRESETS', () => {
  it('contains at least one preset', () => {
    expect(BUILT_IN_PROJECT_DISTRIBUTION_PRESETS.length).toBeGreaterThan(0);
  });

  it.each(BUILT_IN_PROJECT_DISTRIBUTION_PRESETS)(
    'preset "$name" has a non-empty name',
    (preset: ProjectDistributionPresetDefinition) => {
      expect(preset.name).toBeTruthy();
      expect(preset.name.trim().length).toBeGreaterThan(0);
    },
  );

  it.each(BUILT_IN_PROJECT_DISTRIBUTION_PRESETS)(
    'preset "$name" does not carry a project_url field',
    // Presets are config-only (extract_path + verify_files). URLs are
    // per-upload values and would almost always be stale if saved to a preset.
    (preset: ProjectDistributionPresetDefinition) => {
      expect((preset as unknown as Record<string, unknown>).project_url).toBeUndefined();
    },
  );

  it.each(BUILT_IN_PROJECT_DISTRIBUTION_PRESETS)(
    'preset "$name" does not carry a file_name field',
    (preset: ProjectDistributionPresetDefinition) => {
      expect((preset as unknown as Record<string, unknown>).file_name).toBeUndefined();
    },
  );

  it('preset names are unique (case-insensitive)', () => {
    const names = BUILT_IN_PROJECT_DISTRIBUTION_PRESETS.map(p => p.name.toLowerCase());
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('TouchDesigner preset exists and points at TouchDesigner\\Projects', () => {
    const td = BUILT_IN_PROJECT_DISTRIBUTION_PRESETS.find(
      p => p.name.toLowerCase().includes('touchdesigner')
    );
    expect(td).toBeDefined();
    expect(td?.extract_path).toContain('TouchDesigner');
  });
});
