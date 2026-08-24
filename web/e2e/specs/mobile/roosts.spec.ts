/**
 * Mobile /roosts. Viewport / isMobile / hasTouch come from the `mobile-chromium`
 * project in playwright.config.ts.
 *
 * Below `lg` the detail surface is a different component tree entirely:
 * RoostsPageClient renders the portalled `RoostMobileSheet` instead of the
 * inline `<aside>` the desktop specs drive, so this spec is the sheet's only
 * coverage. Uses a dedicated roost + machine, removed in `afterAll`.
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

  // portalled to body; anchor on the wrapped panel's stable id, not the sr-only title
  const panel = page.locator('#roost-detail-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: ROOST_NAME })).toBeVisible();
  await expect(panel.getByLabel('current version v2')).toBeVisible();
  // The head description renders twice (description row + v2 history entry), hence
  // .first(). v1's only exists in the history, proving that section mounted.
  await expect(panel.getByText(HEAD_DESCRIPTION).first()).toBeVisible();
  await expect(panel.getByText('initial import')).toBeVisible();

  // targets open by default; the checked state is encoded in the "remove ... as target" name
  await expect(panel.getByRole('button', { name: 'targets (1)' })).toBeVisible();
  const targetCheckbox = panel.getByRole('checkbox', {
    name: `remove ${MACHINE_ID} as target`,
  });
  await expect(targetCheckbox).toBeVisible();

  await assertNoHorizontalOverflow(page);

  // the only in-place control here that doesn't mutate server state
  await panel.getByRole('button', { name: 'targets (1)' }).click();
  await expect(targetCheckbox).toHaveCount(0);

  await panel.getByRole('button', { name: 'close panel' }).click();
  await expect(panel).toBeHidden();
  await assertNoHorizontalOverflow(page);
});

test('the row actions menu opens over the list', async ({ page }) => {
  await openRoostsPage(page);

  // scope to this roost's row; a co-resident fixture roost would also match
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
  // the trigger stops propagation, so opening the menu must not select the row
  await expect(page.locator('#roost-detail-panel')).toHaveCount(0);
});
