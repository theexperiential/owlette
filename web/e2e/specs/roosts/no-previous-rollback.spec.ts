/**
 * Roosts — single-version roost cannot be rolled back (task 2.4)
 *
 * Gating pattern (b): VersionRow.tsx renders "rollback to this version"
 * with `disabled={isCurrent}` — when the only version IS the head, the
 * menu item is present but disabled. No /api/roosts/{id}/rollback route
 * exists today, so server-side defense is not asserted (flagged in report).
 *
 * Data plane: none.
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
  // versionCount: 1 — v1 is both the only version AND the current head.
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

  // Expand the seeded roost row.
  const roostRow = page.locator(`[data-roost-row="${ROOST_ID}"]`);
  await expect(roostRow).toBeVisible();
  await roostRow.click();
  await expect(
    page.getByRole('button', { name: 'version history' }),
  ).toBeVisible();

  // Exactly one version row. Walk up from `#1` to the row container —
  // mirrors version-history.spec.ts + three-dot-menu.spec.ts.
  const versionRows = page.getByTestId('roost-version-row');
  await expect(versionRows).toHaveCount(1);

  const v1Row = page.locator('[data-testid="roost-version-row"][data-version-number="1"]');
  await expect(v1Row.getByLabel('current version')).toBeVisible();

  // Open the three-dot menu on v1.
  await v1Row.getByRole('button', { name: 'version actions' }).click();

  // Pattern (b): rollback item rendered but disabled. Radix surfaces the
  // disabled state via aria-disabled — Playwright's toBeDisabled accepts it.
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
