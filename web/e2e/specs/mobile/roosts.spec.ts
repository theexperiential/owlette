/**
 * Mobile — /roosts
 *
 * Viewport / isMobile / hasTouch come from the `mobile-chromium` project in
 * playwright.config.ts, which owns every spec under specs/mobile/**.
 *
 * Below `lg` the roost detail surface is a completely different component
 * tree: `RoostsPageClient` gates on a `matchMedia('(min-width: 1024px)')`
 * flag and renders `RoostMobileSheet` (a portalled right-slide Radix dialog)
 * instead of the inline `<aside>` (RoostsPageClient.tsx:104-106, 669, 729).
 * Every desktop `roosts/*.spec.ts` drives the aside, so the sheet had no
 * coverage at all. This spec owns it: open, read, close, plus the row-level
 * actions menu.
 *
 * Isolation: a dedicated roost + machine, both removed in `afterAll`.
 */

import { test, expect, type Page } from '@playwright/test';
import { getAdminDb } from '../../helpers/emulator';
import { assertNoHorizontalOverflow } from '../../helpers/mobile';
import { roleState } from '../../helpers/roles';
import { TEST_SITES, seedMachine, seedRoostWithVersionHistory } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = TEST_SITES[0].id;
const MACHINE_ID = 'e2e-mobile-roost-target';
const ROOST_ID = 'rst_mobile_sheet_001';
const ROOST_NAME = 'mobile-sheet-roost';
const HEAD_DESCRIPTION = 'mobile detail sheet fixture';

async function openRoostsPage(page: Page): Promise<void> {
  await page.goto('/roosts');
  await expect(page.getByRole('heading', { name: 'roosts', exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator(`[data-roost-row="${ROOST_ID}"]`)).toBeVisible();
}

test.beforeAll(async () => {
  await seedMachine(SITE_ID, MACHINE_ID);
  await seedRoostWithVersionHistory(SITE_ID, ROOST_ID, {
    name: ROOST_NAME,
    targets: [MACHINE_ID],
    versionCount: 2,
    descriptions: ['initial import', HEAD_DESCRIPTION],
  });
});

test.afterAll(async () => {
  const db = getAdminDb();
  const roostRef = db.collection('sites').doc(SITE_ID).collection('roosts').doc(ROOST_ID);
  const versions = await roostRef.collection('versions').get();
  await Promise.all(versions.docs.map((d) => d.ref.delete()));
  await Promise.all([
    roostRef.delete(),
    db.collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID).delete(),
  ]);
});

test('tapping a roost row opens the mobile detail sheet and closes again', async ({ page }) => {
  await openRoostsPage(page);
  await assertNoHorizontalOverflow(page);

  await page.locator(`[data-roost-row="${ROOST_ID}"]`).click();

  // The sheet is portalled to document.body — the panel it wraps carries the
  // stable id, so anchor there rather than on the sheet's sr-only title.
  const panel = page.locator('#roost-detail-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: ROOST_NAME })).toBeVisible();
  await expect(panel.getByLabel('current version v2')).toBeVisible();
  // The head description renders twice inside the panel — once in the
  // description row, once as the v2 entry in the version history — so take
  // the first. v1's description only exists in the history, which is what
  // proves that section mounted inside the sheet too.
  await expect(panel.getByText(HEAD_DESCRIPTION).first()).toBeVisible();
  await expect(panel.getByText('initial import')).toBeVisible();

  // Targets section is open by default; the seeded machine is checked, which
  // is what its "remove … as target" accessible name encodes.
  await expect(panel.getByRole('button', { name: 'targets (1)' })).toBeVisible();
  const targetCheckbox = panel.getByRole('checkbox', {
    name: `remove ${MACHINE_ID} as target`,
  });
  await expect(targetCheckbox).toBeVisible();

  await assertNoHorizontalOverflow(page);

  // Collapsing the targets section is the panel's only in-place control that
  // does not mutate server state.
  await panel.getByRole('button', { name: 'targets (1)' }).click();
  await expect(targetCheckbox).toHaveCount(0);

  await panel.getByRole('button', { name: 'close panel' }).click();
  await expect(panel).toBeHidden();
  await assertNoHorizontalOverflow(page);
});

test('the row actions menu opens over the list', async ({ page }) => {
  await openRoostsPage(page);

  // Each row has its own ⋮ trigger; scope to this roost's row container so a
  // co-resident fixture roost cannot satisfy the locator.
  const row = page
    .locator(`[data-roost-row="${ROOST_ID}"]`)
    .locator('xpath=parent::div');
  await row.getByRole('button', { name: 'row actions' }).click();

  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /re-sync targets/i })).toBeEnabled();
  await expect(menu.getByRole('menuitem', { name: /copy roost id/i })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /delete roost/i })).toBeVisible();

  await assertNoHorizontalOverflow(page);

  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  // Opening the menu must not have selected the row (the trigger stops
  // propagation), so the detail sheet stays closed.
  await expect(page.locator('#roost-detail-panel')).toHaveCount(0);
});
