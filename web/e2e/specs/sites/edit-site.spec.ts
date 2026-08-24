/**
 * Sites — inline rename in the manage-sites dialog: superadmin opens the
 * switcher, edits a dedicated `site-to-rename` row (seeded per test so the
 * shared site-A / site-B baseline stays untouched), saves, and the spec asserts
 * the toast, the row leaving edit mode, and an Admin SDK read-through of
 * sites/site-to-rename.name.
 *
 * Edge: an empty name toasts an error, stays in edit mode, and writes nothing.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedSite } from '../../helpers/seed';

test.use(roleState('superadmin'));

const RENAMEABLE_SITE_ID = 'site-to-rename';
const ORIGINAL_NAME = 'Original Rename Target';

test.beforeEach(async () => {
  // Re-seed before every test so a previous rename doesn't leak (setDoc overwrites).
  await seedSite({
    id: RENAMEABLE_SITE_ID,
    name: ORIGINAL_NAME,
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

test('superadmin can rename a site inline via manage-sites', async ({ page }) => {
  const newName = `Renamed ${Date.now()}`;
  const dialog = await openManageSitesDialog(page);

  // Click edit on the seeded rename target — aria-label disambiguates rows.
  await dialog.getByRole('button', { name: `edit ${ORIGINAL_NAME}` }).click();

  // The row swaps into edit mode with the name input auto-focused.
  const nameInput = dialog.getByLabel('site name');
  await expect(nameInput).toHaveValue(ORIGINAL_NAME);
  await nameInput.fill(newName);

  await dialog.getByRole('button', { name: /^save$/i }).click();

  // Toast fires and the row exits edit mode (edit button returns, new label).
  await expect(page.getByText(/updated successfully/i)).toBeVisible();
  await expect(dialog.getByRole('button', { name: `edit ${newName}` }))
    .toBeVisible({ timeout: 5_000 });

  // Admin SDK read-through — the real contract assertion.
  const db = getAdminDb();
  const snap = await db.collection('sites').doc(RENAMEABLE_SITE_ID).get();
  expect(snap.exists).toBe(true);
  expect(snap.data()!.name).toBe(newName);
});

test('saving an empty name shows an error and keeps the row in edit mode', async ({ page }) => {
  const dialog = await openManageSitesDialog(page);

  await dialog.getByRole('button', { name: `edit ${ORIGINAL_NAME}` }).click();

  const nameInput = dialog.getByLabel('site name');
  await nameInput.fill('   '); // whitespace-only — trim() will reject

  await dialog.getByRole('button', { name: /^save$/i }).click();

  // Validation toast fires and the row stays in edit mode (save still visible).
  await expect(page.getByText(/site name cannot be empty/i)).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^save$/i })).toBeVisible();

  // Firestore unchanged.
  const db = getAdminDb();
  const snap = await db.collection('sites').doc(RENAMEABLE_SITE_ID).get();
  expect(snap.data()!.name).toBe(ORIGINAL_NAME);
});
