/** @jest-environment node */

/**
 * The picker's eligibility rule has to agree with the server's, or the UI
 * offers successors the reassign API will refuse. These tests pin the four
 * cases the capability matrix decides, plus the ordering the picker relies on.
 *
 * The authoritative check lives in `reassignTalons` and is covered in
 * `__tests__/lib/talons/store.test.ts`; this is the mirror.
 */

import { eligibleTalonSuccessors } from '@/lib/talonSuccessors';

const SITE = 'site-a';

const USERS = [
  { uid: 'zoe-admin', email: 'zoe@example.com', role: 'admin', sites: [SITE] },
  { uid: 'amy-admin', email: 'amy@example.com', role: 'admin', sites: [SITE] },
  { uid: 'other-admin', email: 'other@example.com', role: 'admin', sites: ['site-b'] },
  { uid: 'root', email: 'root@example.com', role: 'superadmin', sites: [] },
  { uid: 'mem', email: 'mem@example.com', role: 'member', sites: [SITE] },
  {
    uid: 'gone',
    email: 'gone@example.com',
    role: 'admin',
    sites: [SITE],
    deletedAt: 1_700_000_000_000,
  },
];

describe('eligibleTalonSuccessors', () => {
  it('offers site admins and superadmins, in label order', () => {
    expect(eligibleTalonSuccessors(USERS, { siteId: SITE })).toEqual([
      { uid: 'amy-admin', label: 'amy@example.com' },
      { uid: 'root', label: 'root@example.com' },
      { uid: 'zoe-admin', label: 'zoe@example.com' },
    ]);
  });

  it('excludes an admin scoped to a different site — TALON_MANAGE is site-scoped', () => {
    const uids = eligibleTalonSuccessors(USERS, { siteId: SITE }).map((c) => c.uid);
    expect(uids).not.toContain('other-admin');
  });

  it('excludes members — they could not have authored the talon either', () => {
    const uids = eligibleTalonSuccessors(USERS, { siteId: SITE }).map((c) => c.uid);
    expect(uids).not.toContain('mem');
  });

  it('excludes soft-deleted accounts — the exact failure this feature prevents', () => {
    const uids = eligibleTalonSuccessors(USERS, { siteId: SITE }).map((c) => c.uid);
    expect(uids).not.toContain('gone');
  });

  it('never offers the departing user as their own successor', () => {
    const uids = eligibleTalonSuccessors(USERS, {
      siteId: SITE,
      excludeUid: 'zoe-admin',
    }).map((c) => c.uid);
    expect(uids).not.toContain('zoe-admin');
  });

  it('keeps every admin when no site is named — the fleet-wide delete flow', () => {
    // Per-site eligibility is re-checked server-side once per site; hiding
    // admins here would under-offer for the sites they DO cover.
    const uids = eligibleTalonSuccessors(USERS).map((c) => c.uid);
    expect(uids).toEqual(['amy-admin', 'other-admin', 'root', 'zoe-admin']);
  });

  it('falls back to display name, then uid, when there is no email', () => {
    expect(
      eligibleTalonSuccessors([
        { uid: 'u1', displayName: 'Ada', role: 'admin', sites: [SITE] },
        { uid: 'u2', role: 'admin', sites: [SITE] },
      ], { siteId: SITE }),
    ).toEqual([
      { uid: 'u1', label: 'Ada' },
      { uid: 'u2', label: 'u2' },
    ]);
  });
});
