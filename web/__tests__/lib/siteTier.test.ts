/**
 * @jest-environment node
 *
 * Tests for `web/lib/siteTier.ts` (api-sprint wave 3.2).
 */
import { BETA_DEFAULT_TIER, getSiteTier } from '@/lib/siteTier';

describe('getSiteTier', () => {
  it('returns the beta default for sites with no tier field', () => {
    // Existing site docs predate the `tier` field — they must resolve to
    // the beta default so nothing breaks for users on legacy data.
    expect(getSiteTier({})).toBe(BETA_DEFAULT_TIER);
  });

  it('returns the beta default when the input is undefined', () => {
    expect(getSiteTier(undefined)).toBe(BETA_DEFAULT_TIER);
  });

  it('returns the beta default when the input is null', () => {
    expect(getSiteTier(null)).toBe(BETA_DEFAULT_TIER);
  });

  it('returns the beta default when tier is null', () => {
    expect(getSiteTier({ tier: null })).toBe(BETA_DEFAULT_TIER);
  });

  it('returns the beta default for unknown tier strings', () => {
    // Defensive: a stray write of an unknown value (e.g. mid-migration
    // typo) must not bypass the gate or leak into UI rendering. Treat
    // anything that isn't `'core' | 'pro'` as undefined.
    expect(getSiteTier({ tier: 'enterprise' })).toBe(BETA_DEFAULT_TIER);
  });

  it('returns "core" when tier is the literal "core"', () => {
    expect(getSiteTier({ tier: 'core' })).toBe('core');
  });

  it('returns "pro" when tier is the literal "pro"', () => {
    expect(getSiteTier({ tier: 'pro' })).toBe('pro');
  });

  it('exports BETA_DEFAULT_TIER as "pro" during the public beta', () => {
    // This test is intentionally tight: the beta-exit migration should
    // flip BOTH this constant and this assertion. Failing here is the
    // signal that the rest of the codebase is ready to start gating.
    expect(BETA_DEFAULT_TIER).toBe('pro');
  });
});
