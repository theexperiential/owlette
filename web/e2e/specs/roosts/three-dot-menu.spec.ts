/**
 * Roosts — version-row three-dot menu: the four actions render, "copy version
 * id" reaches the clipboard, and rollback/diff are disabled on the head
 * version. No data plane.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedRoostWithVersionHistory } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const ROOST_ID = 'rst_test_menu_001';
const VERSION_COUNT = 3;
// Mirrors seedRoostWithVersionHistory's deterministic id format.
const versionIdFor = (n: number) => `vrs_${ROOST_ID}_v${n}`;

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
  await seedRoostWithVersionHistory(SITE_ID, ROOST_ID, {
    versionCount: VERSION_COUNT,
  });
});

test.afterEach(async () => {
  await cleanup();
});

/** The row container for version #N, per version-history.spec.ts's convention. */
function rowFor(page: import('@playwright/test').Page, n: number) {
  return page.locator(`[data-testid="roost-version-row"][data-version-number="${n}"]`);
}

async function expandRoostAndOpenMenu(
  page: import('@playwright/test').Page,
  versionNumber: number,
) {
  await page.goto('/roosts');
  await expect(page.getByRole('heading', { name: 'roosts', exact: true })).toBeVisible({ timeout: 10_000 });

  await page.locator(`[data-roost-row="${ROOST_ID}"]`).click();
  await expect(page.getByRole('button', { name: 'version history' })).toBeVisible();

  const row = rowFor(page, versionNumber);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'version actions' }).click();
}

test('non-current row menu renders rollback, copy id, view files, diff', async ({ page }) => {
  await expandRoostAndOpenMenu(page, 2);

  await expect(page.getByRole('menuitem', { name: /^rollback to this version$/i })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /^copy version id$/i })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /^view files$/i })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /^diff against current$/i })).toBeVisible();

  // Enabled, not merely present.
  await expect(page.getByRole('menuitem', { name: /^rollback to this version$/i })).toBeEnabled();
  await expect(page.getByRole('menuitem', { name: /^diff against current$/i })).toBeEnabled();
});

test('copy version id writes the row\'s vrs_* id to the clipboard', async ({ page, context }) => {
  // Chromium requires these for navigator.clipboard.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  await expandRoostAndOpenMenu(page, 2);
  await page.getByRole('menuitem', { name: /^copy version id$/i }).click();

  // Waiting on the toast guarantees the clipboard write resolved first.
  await expect(page.getByText('version id copied')).toBeVisible();

  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toBe(versionIdFor(2));
});

test('current-version row disables rollback + diff (no-op guard)', async ({ page }) => {
  await expandRoostAndOpenMenu(page, VERSION_COUNT);

  // Disabled rather than hidden when isCurrent — a no-op rollback to the head
  // would be confusing UX. Copy id + view files stay enabled.
  await expect(page.getByRole('menuitem', { name: /^rollback to this version$/i })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: /^diff against current$/i })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: /^copy version id$/i })).toBeEnabled();
  await expect(page.getByRole('menuitem', { name: /^view files$/i })).toBeEnabled();
});
