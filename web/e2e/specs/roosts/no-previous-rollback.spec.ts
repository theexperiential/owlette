/**
 * Roosts — a single-version roost cannot be rolled back.
 *
 * VersionRow renders "rollback to this version" with `disabled={isCurrent}`, so
 * on a one-version roost the item is present but disabled. There is no
 * /api/roosts/{id}/rollback route yet, so no server-side assertion here.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedRoostWithVersionHistory } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const ROOST_ID = 'rst_test_single_001';

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
  // v1 is both the only version and the current head.
  await seedRoostWithVersionHistory(SITE_ID, ROOST_ID, { versionCount: 1 });
});

test.afterEach(async () => {
  await cleanup();
});

test('rollback action is disabled on the only/current version', async ({ page }) => {
  await page.goto('/roosts');
  await expect(
    page.getByRole('heading', { name: 'roosts', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  const roostRow = page.locator(`[data-roost-row="${ROOST_ID}"]`);
  await expect(roostRow).toBeVisible();
  await roostRow.click();
  await expect(
    page.getByRole('button', { name: 'version history' }),
  ).toBeVisible();

  // Walk up from `#1` to the row container, as version-history.spec.ts does.
  const versionRows = page.getByTestId('roost-version-row');
  await expect(versionRows).toHaveCount(1);

  const v1Row = page.locator('[data-testid="roost-version-row"][data-version-number="1"]');
  await expect(v1Row.getByLabel('current version')).toBeVisible();

  await v1Row.getByRole('button', { name: 'version actions' }).click();

  // Radix marks disabled items with aria-disabled, which toBeDisabled accepts.
  const rollback = page.getByRole('menuitem', {
    name: /^rollback to this version$/i,
  });
  await expect(rollback).toBeVisible();
  await expect(rollback).toBeDisabled();

  // Sibling actions unaffected.
  await expect(
    page.getByRole('menuitem', { name: /^copy version id$/i }),
  ).toBeEnabled();
  await expect(
    page.getByRole('menuitem', { name: /^view files$/i }),
  ).toBeEnabled();
});
