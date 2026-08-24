/**
 * Sites — two-step delete flow (C2.3): trash -> nested confirm dialog; confirming
 * writes to Firestore and toasts, cancelling does neither. `site-to-delete` is
 * re-seeded in beforeEach so the shared baseline is untouched and the cancel
 * test can assert existence without depending on order.
 *
 * Not covered: the single-site delete block — the baseline always has >=3 sites,
 * so exercising it needs per-test emulator isolation we don't have yet.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedSite } from '../../helpers/seed';

test.use(roleState('superadmin'));

const DELETEABLE_SITE_ID = 'site-to-delete';
const DELETEABLE_SITE_NAME = 'Original Delete Target';

test.beforeEach(async () => {
  // so a prior delete can't leak into the next test
  await seedSite({
    id: DELETEABLE_SITE_ID,
    name: DELETEABLE_SITE_NAME,
    owner: 'someone-else',
    timezone: 'UTC',
  });
});

async function openManageSitesDialog(page: import('@playwright/test').Page) {
  await page.goto('/dashboard');
  await page.getByTestId('site-switcher-trigger').click();
  await page.getByRole('menuitem', { name: /manage sites/i }).click();
  const dialog = page.getByRole('dialog', { name: /manage sites/i });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('superadmin can delete a site via manage-sites confirmation', async ({ page }) => {
  const manageDialog = await openManageSitesDialog(page);

  // second icon button on the row; disambiguated by the C2.2 aria-label
  await manageDialog
    .getByRole('button', { name: `delete ${DELETEABLE_SITE_NAME}` })
    .click();

  // scope by title: the manage-sites dialog is still open behind this one
  const confirmDialog = page.getByRole('dialog', { name: /^delete site$/i });
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog).toContainText(DELETEABLE_SITE_NAME);

  // exact match: "delete {site name}" rows behind would match the substring
  await confirmDialog
    .getByRole('button', { name: 'delete site', exact: true })
    .click();

  await expect(page.getByText(/deleted successfully/i)).toBeVisible();

  const db = getAdminDb();
  const snap = await db.collection('sites').doc(DELETEABLE_SITE_ID).get();
  expect(snap.exists).toBe(false);
});

test('cancelling the delete-confirmation keeps the site', async ({ page }) => {
  const manageDialog = await openManageSitesDialog(page);

  await manageDialog
    .getByRole('button', { name: `delete ${DELETEABLE_SITE_NAME}` })
    .click();

  const confirmDialog = page.getByRole('dialog', { name: /^delete site$/i });
  await expect(confirmDialog).toBeVisible();

  await confirmDialog.getByRole('button', { name: /^cancel$/i }).click();

  await expect(confirmDialog).toBeHidden();
  await expect(
    manageDialog.getByRole('button', { name: `delete ${DELETEABLE_SITE_NAME}` }),
  ).toBeVisible();

  const db = getAdminDb();
  const snap = await db.collection('sites').doc(DELETEABLE_SITE_ID).get();
  expect(snap.exists).toBe(true);
  expect(snap.data()!.name).toBe(DELETEABLE_SITE_NAME);
});
