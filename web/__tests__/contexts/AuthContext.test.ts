/**
 * AuthContext role-helper unit tests
 *
 * Tests the pure `computeIsSuperadmin` and `computeIsSiteAdmin` helpers
 * (extracted from AuthContext so they're testable without mounting the
 * full provider + its Firebase deps).
 *
 * The matrix: each of {null, member, admin, superadmin} × {site in userSites,
 * site NOT in userSites} — covering the 6 role × in-sites combinations from
 * the plan plus the null (pre-auth) case.
 */

import { computeIsSuperadmin, computeIsSiteAdmin } from '@/contexts/AuthContext';

const SITE_IN = 'site-A';
const SITE_OUT = 'site-B';
const USER_SITES = [SITE_IN];

describe('computeIsSuperadmin', () => {
  it('is false for null role (pre-auth / missing user doc / listener error)', () => {
    expect(computeIsSuperadmin(null)).toBe(false);
  });

  it('is false for member role', () => {
    expect(computeIsSuperadmin('member')).toBe(false);
  });

  it('is false for site-scoped admin role', () => {
    // The middle tier must NOT be confused with platform god-mode.
    expect(computeIsSuperadmin('admin')).toBe(false);
  });

  it('is true for superadmin role', () => {
    expect(computeIsSuperadmin('superadmin')).toBe(true);
  });
});

describe('computeIsSiteAdmin', () => {
  describe('null role', () => {
    it('is false for site in userSites', () => {
      expect(computeIsSiteAdmin(null, USER_SITES, SITE_IN)).toBe(false);
    });

    it('is false for site NOT in userSites', () => {
      expect(computeIsSiteAdmin(null, USER_SITES, SITE_OUT)).toBe(false);
    });
  });

  describe('member role', () => {
    it('is false for site in userSites', () => {
      // Members never get site-admin powers, even on assigned sites.
      expect(computeIsSiteAdmin('member', USER_SITES, SITE_IN)).toBe(false);
    });

    it('is false for site NOT in userSites', () => {
      expect(computeIsSiteAdmin('member', USER_SITES, SITE_OUT)).toBe(false);
    });
  });

  describe('admin role (site-scoped middle tier)', () => {
    it('is true for site in userSites', () => {
      expect(computeIsSiteAdmin('admin', USER_SITES, SITE_IN)).toBe(true);
    });

    it('is false for site NOT in userSites', () => {
      // Critical invariant: admins are NOT god-mode. Unassigned sites must be denied.
      expect(computeIsSiteAdmin('admin', USER_SITES, SITE_OUT)).toBe(false);
    });

    it('is false when userSites is empty', () => {
      expect(computeIsSiteAdmin('admin', [], SITE_IN)).toBe(false);
    });
  });

  describe('superadmin role (god-mode)', () => {
    it('is true for site in userSites', () => {
      expect(computeIsSiteAdmin('superadmin', USER_SITES, SITE_IN)).toBe(true);
    });

    it('is true for site NOT in userSites (god-mode fall-through)', () => {
      // Mirrors firestore.rules canAccessSite post-0.2.2 — superadmins access
      // every site regardless of the sites[] array.
      expect(computeIsSiteAdmin('superadmin', USER_SITES, SITE_OUT)).toBe(true);
    });

    it('is true even when userSites is empty', () => {
      expect(computeIsSiteAdmin('superadmin', [], SITE_OUT)).toBe(true);
    });
  });
});
