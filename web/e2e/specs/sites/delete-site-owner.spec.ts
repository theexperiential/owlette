/**
 * Sites — delete as the role a real self-serve customer actually has.
 *
 * Every signup is born `role: 'member'` (`lib/actions/bootstrapUser.server.ts`) and
 * `POST /api/sites` has no capability gate, so the person who creates a site is a
 * member who owns it. `member` holds no site-scoped capability, so authorization
 * has to come from ownership — `authorizedSiteHandler` grants it by short-circuiting
 * on `sites/{id}.owner`, mirroring `app/api/_shared.ts:requireSiteCapability`.
 *
 * Without that short-circuit this deletes nothing and the UI toasts "capability not
 * granted" (reported on production by Davor, 2026-09-04). `delete-site.spec.ts` could
 * never catch it: it runs `roleState('superadmin')`, and superadmin returns true from
 * `hasCapability` before the site is ever considered.
 *
 * The second test is the negative control. Ownership must be what grants this, not
 * membership — a member assigned to a site they do not own still gets 403.
 */

import { test, expect } from '@playwright/test';
import { FieldValue } from 'firebase-admin/firestore';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedSite, TEST_USERS } from '../../helpers/seed';

test.use(roleState('member'));

const MEMBER_UID = TEST_USERS.member.uid;
const OWNED_SITE_ID = 'site-owned-by-member';
const OWNED_SITE_NAME = 'Member Owned Site';
/** Seeded baseline site: assigned to the member, owned by someone else. */
const ASSIGNED_SITE_NAME = 'Site A (Assigned)';

test.beforeEach(async () => {
  await seedSite({
    id: OWNED_SITE_ID,
    name: OWNED_SITE_NAME,
    owner: MEMBER_UID,
    timezone: 'UTC',
  });
  // Membership as well as ownership: `useSites` lists from `users/{uid}.sites[]`,
  // so an owned-but-unlisted site never reaches the dialog to be clicked.
  await getAdminDb()
    .collection('users')
    .doc(MEMBER_UID)
    .update({ sites: FieldValue.arrayUnion(OWNED_SITE_ID) });
});

test.afterEach(async () => {
  // Restore the shared baseline — later specs assert against the member's own sites.
  await getAdminDb()
    .collection('users')
    .doc(MEMBER_UID)
    .update({ sites: FieldValue.arrayRemove(OWNED_SITE_ID) });
  await getAdminDb().collection('sites').doc(OWNED_SITE_ID).delete();
});

async function openManageSitesDialog(page: import('@playwright/test').Page) {
  await page.goto('/dashboard');
  await page.getByTestId('site-switcher-trigger').click();
  await page.getByRole('menuitem', { name: /manage sites/i }).click();
  const dialog = page.getByRole('dialog', { name: /manage sites/i });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function confirmDeleteOf(page: import('@playwright/test').Page, siteName: string) {
  const manageDialog = await openManageSitesDialog(page);
  await manageDialog.getByRole('button', { name: `delete ${siteName}` }).click();

  // Scope by title: the manage-sites dialog is still open behind this one.
  const confirmDialog = page.getByRole('dialog', { name: /^delete site$/i });
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog).toContainText(siteName);

  // Exact match: the "delete {site name}" row buttons behind would match the substring.
  await confirmDialog.getByRole('button', { name: 'delete site', exact: true }).click();
}

test('a member can delete a site they own', async ({ page }) => {
  await confirmDeleteOf(page, OWNED_SITE_NAME);

  await expect(page.getByText(/deleted successfully/i)).toBeVisible();

  const snap = await getAdminDb().collection('sites').doc(OWNED_SITE_ID).get();
  expect(snap.exists).toBe(false);
});

test('a member cannot delete a site they are only assigned to', async ({ page }) => {
  await confirmDeleteOf(page, ASSIGNED_SITE_NAME);

  await expect(page.getByText(/capability not granted/i)).toBeVisible();

  const snap = await getAdminDb().collection('sites').doc('site-A').get();
  expect(snap.exists).toBe(true);
});
