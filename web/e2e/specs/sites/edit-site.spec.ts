/**
 * Sites — edit-site inline rename (C2.2)
 *
 * The manage-sites dialog renders each site row with an edit button that
 * swaps the row in place into an inline editor (name + timezone). This spec
 * exercises the rename flow:
 *   - superadmin opens switcher → "manage sites"
 *   - clicks the pencil on a dedicated `site-to-rename` row (seeded in
 *     beforeAll so we don't mutate the shared site-A / site-B baseline)
 *   - clears the name, types a new one, clicks save
 *   - asserts toast + the row exits edit mode showing the new name
 *   - Admin SDK read-through: sites/site-to-rename.name matches the new value
 *
 * Edge: empty name shows a validation error and the row stays in edit mode
 * (the save button issues a toast.error, no Firestore write happens).
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedSite } from '../../helpers/seed';

test.use(roleState('superadmin'));

const RENAMEABLE_SITE_ID = 'site-to-rename';
const ORIGINAL_NAME = 'Original Rename Target';

test.beforeEach(async () => {
  // Re-seed before every test so the previous test's rename doesn't leak.
  // setDoc is idempotent — it overwrites whatever the prior test left.
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

  // The row swaps into edit mode — the name input is auto-focused with the
  // current value. Clear and type the new name.
  const nameInput = dialog.getByLabel('site name');
  await expect(nameInput).toHaveValue(ORIGINAL_NAME);
  await nameInput.fill(newName);

  await dialog.getByRole('button', { name: /^save$/i }).click();

  // Toast fires + the row exits edit mode (the edit button returns, now
  // labeled with the new name).
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

  // Validation toast fires and the row stays in edit mode (the save button
  // is still visible; no "edit" affordance has reappeared).
  await expect(page.getByText(/site name cannot be empty/i)).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^save$/i })).toBeVisible();

  // Firestore unchanged.
  const db = getAdminDb();
  const snap = await db.collection('sites').doc(RENAMEABLE_SITE_ID).get();
  expect(snap.data()!.name).toBe(ORIGINAL_NAME);
});
