/**
 * Sites — delete-site flow (C2.3)
 *
 * Tests the two-step delete flow:
 *   - click trash on a site row → nested confirmation dialog opens
 *   - confirming writes to Firestore + toasts; cancelling does neither
 *
 * A dedicated `site-to-delete` is seeded in beforeEach so tests don't
 * mutate the shared baseline (`site-A` / `site-B`). Re-seeding after each
 * test also means the "cancel" test can assert the site *still* exists
 * without depending on test order.
 *
 * Not covered: single-site delete-block. The trash button is disabled and
 * the handler returns early when `sites.length === 1`, but the baseline
 * always has ≥3 sites (site-A, site-B, plus whatever C2.x seeded), so
 * we'd need per-test emulator isolation to exercise the 1-site state.
 * Deferred until we have that primitive.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedSite } from '../../helpers/seed';

test.use(roleState('superadmin'));

const DELETEABLE_SITE_ID = 'site-to-delete';
const DELETEABLE_SITE_NAME = 'Original Delete Target';

test.beforeEach(async () => {
  // Re-seed every test so a prior delete doesn't leak into the next one.
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

  // Trash button is the second icon button on the row — disambiguated by
  // the aria-label we added in C2.2.
  await manageDialog
    .getByRole('button', { name: `delete ${DELETEABLE_SITE_NAME}` })
    .click();

  // The nested confirmation dialog opens — scope by its unique title so we
  // don't accidentally target the still-open manage-sites dialog behind it.
  const confirmDialog = page.getByRole('dialog', { name: /^delete site$/i });
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog).toContainText(DELETEABLE_SITE_NAME);

  // Confirm. Exact match required — otherwise "delete {site name}" rows
  // behind this dialog would also match substring "delete site".
  await confirmDialog
    .getByRole('button', { name: 'delete site', exact: true })
    .click();

  await expect(page.getByText(/deleted successfully/i)).toBeVisible();

  // Admin SDK read-through — the real contract assertion.
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

  // Confirm dialog closes; the manage-sites dialog is still open and the
  // site row is still present.
  await expect(confirmDialog).toBeHidden();
  await expect(
    manageDialog.getByRole('button', { name: `delete ${DELETEABLE_SITE_NAME}` }),
  ).toBeVisible();

  // Firestore unchanged.
  const db = getAdminDb();
  const snap = await db.collection('sites').doc(DELETEABLE_SITE_ID).get();
  expect(snap.exists).toBe(true);
  expect(snap.data()!.name).toBe(DELETEABLE_SITE_NAME);
});
