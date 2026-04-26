/**
 * Roosts — modal disambiguation: new roost vs new version (task 3.5)
 *
 * Asserts ProjectDistributionDialog opens in the right mode from each
 * entry point: "new roost" mode from the page-level create button vs
 * "publish new version of {name}" mode from the per-roost button in
 * the version-history panel. Pure UX correctness — no submits.
 *
 * Data plane: none.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine, seedRoostWithVersionHistory } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-modaldisambig-machine';
const ROOST_ID = 'rst_test_modaldisambig_001';
const ROOST_NAME = 'lobby';

async function cleanup() {
  const db = getAdminDb();
  const versions = await db
    .collection('sites').doc(SITE_ID)
    .collection('roosts').doc(ROOST_ID)
    .collection('versions').get();
  await Promise.all(versions.docs.map((d) => d.ref.delete()));
  await db.collection('sites').doc(SITE_ID).collection('roosts').doc(ROOST_ID).delete();
}

test.beforeEach(async () => {
  await cleanup();
  await seedMachine(SITE_ID, MACHINE_ID);
  await seedRoostWithVersionHistory(SITE_ID, ROOST_ID, {
    versionCount: 2,
    name: ROOST_NAME,
  });
});

test.afterEach(async () => {
  await cleanup();
});

test('top-level "+ new roost" opens dialog in new-roost mode (name editable)', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (e) => pageErrors.push(e));
  await page.goto('/roosts');
  await expect(page.getByRole('heading', { name: 'roosts', exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: /^new roost$/i }).first().click();

  // Title is the literal "new roost" — NOT "publish new version of …".
  const dialog = page.getByRole('dialog', { name: /^new roost$/i });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: /^new roost$/i })).toBeVisible();
  await expect(dialog.getByText(/publish new version of/i)).toHaveCount(0);

  const nameInput = dialog.locator('#distribution-name');
  await expect(nameInput).toBeEnabled();
  await expect(nameInput).toHaveValue('');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(pageErrors, `pageerror events: ${pageErrors.map((e) => e.message).join(' | ')}`).toHaveLength(0);
});

test('per-roost "+ new version" opens dialog in new-version mode with locked fields', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (e) => pageErrors.push(e));
  await page.goto('/roosts');
  await expect(page.getByRole('heading', { name: 'roosts', exact: true })).toBeVisible({ timeout: 10_000 });
  await page.locator(`[data-roost-row="${ROOST_ID}"]`).click();
  await expect(page.getByRole('button', { name: 'version history' })).toBeVisible();
  await page.getByRole('button', { name: /^new version$/i }).click();

  // Title is `publish new version of "lobby"` — the roost name disambiguates.
  const dialog = page.getByRole('dialog', { name: /^publish new version of "lobby"$/i });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: /^publish new version of "lobby"$/i })).toBeVisible();

  // Name is locked + pre-filled, extract path disabled.
  const nameInput = dialog.locator('#distribution-name');
  await expect(nameInput).toBeDisabled();
  await expect(nameInput).toHaveValue(ROOST_NAME);
  await expect(dialog.locator('#extract-path')).toBeDisabled();

  // Targets — every checkbox disabled, section label gets "— locked" suffix.
  await expect(dialog.getByText(/target machines.*locked/i)).toBeVisible();
  const targetCheckboxes = dialog.getByRole('checkbox');
  const checkboxCount = await targetCheckboxes.count();
  expect(checkboxCount).toBeGreaterThan(0);
  for (let i = 0; i < checkboxCount; i++) {
    await expect(targetCheckboxes.nth(i)).toBeDisabled();
  }

  // Description stays editable — it's the "what changed?" field.
  await expect(dialog.locator('#distribution-description')).toBeEnabled();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(pageErrors, `pageerror events: ${pageErrors.map((e) => e.message).join(' | ')}`).toHaveLength(0);
});

test('top-level button does not cross-wire into the new-version flow', async ({ page }) => {
  // Regression guard — clicking the top-level button must produce
  // new-roost mode, not new-version mode wired to a list-top roost.
  await page.goto('/roosts');
  await expect(page.getByRole('heading', { name: 'roosts', exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: /^new roost$/i }).first().click();

  const dialog = page.getByRole('dialog', { name: /^new roost$/i });
  await expect(dialog).toBeVisible();
  // No leak of the seeded roost name or version-mode title.
  await expect(dialog.getByRole('heading')).not.toContainText(ROOST_NAME);
  await expect(dialog.getByRole('heading')).not.toContainText(/publish new version/i);

  const nameInput = dialog.locator('#distribution-name');
  await expect(nameInput).toBeEnabled();
  await expect(nameInput).toHaveValue('');
});
