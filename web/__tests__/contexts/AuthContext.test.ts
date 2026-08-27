/**
 * The pure `computeIsSuperadmin` / `computeIsSiteAdmin` / `shouldListenerBootstrap`
 * helpers, extracted from AuthContext so they test without mounting the provider
 * and its Firebase deps.
 *
 * Role matrix (compute*): {null, member, admin, superadmin} x {site in
 * userSites, site not in userSites}.
 */

import {
  computeIsSuperadmin,
  computeIsSiteAdmin,
  shouldListenerBootstrap,
} from '@/contexts/AuthContext';

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
      // Admins are NOT god-mode: unassigned sites must be denied.
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
      // Mirrors firestore.rules canAccessSite: superadmins reach every site
      // regardless of sites[].
      expect(computeIsSiteAdmin('superadmin', USER_SITES, SITE_OUT)).toBe(true);
    });

    it('is true even when userSites is empty', () => {
      expect(computeIsSiteAdmin('superadmin', [], SITE_OUT)).toBe(true);
    });
  });
});

describe('shouldListenerBootstrap', () => {
  it('bootstraps when nothing is in flight (google sign-in / cold recovery)', async () => {
    await expect(shouldListenerBootstrap(null)).resolves.toBe(true);
  });

  it('stands down while the tokened signUp bootstrap is still in flight', async () => {
    // The listener has no Turnstile token; racing signUp spent a rejected
    // challenge on every email/password signup (drift-audit item 9).
    let resolve!: (value: { alreadyExists: boolean }) => void;
    const pending = new Promise<{ alreadyExists: boolean }>(r => { resolve = r; });

    const decision = shouldListenerBootstrap(pending);
    resolve({ alreadyExists: false });

    await expect(decision).resolves.toBe(false);
  });

  it('still bootstraps when the signUp attempt actually failed — the recovery path', async () => {
    // Standing down must not cost us the reason this path exists.
    const failed = Promise.reject(new Error('siteverify blip'));
    await expect(shouldListenerBootstrap(failed)).resolves.toBe(true);
  });
});
