/**
 * Roosts — `/roosts?roost=<id>` opens the detail panel directly.
 *
 * Regression guard for a bug that shipped in `0900095f`. `useRoosts` derives
 * `loading` as `!!db && !!siteId && !loaded`, so on the first render — before
 * `useCurrentSite` resolves and while `siteId` is still '' — it reports NOT
 * loading against an empty list. That opened `RoostsPageClient`'s
 * clear-the-selection effect on exactly the render where a deep link is most
 * fragile, and `?roost=<id>` was stripped from the URL before the list arrived.
 * Clicking a row still worked, so only the URL-driven path was dead — which is
 * why it went unnoticed and why `e2e/videos/10-distribute-with-roost.video.ts`
 * carries a row-click workaround instead of a deep link.
 *
 * The fix gates that effect on the site having resolved. This asserts the
 * outcome rather than the mechanism: land on the URL, get the panel, keep the
 * param. No data plane.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine, seedRoostWithVersionHistory } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-roost-deep-link';
const ROOST_ID = 'rst_test_deep_link_001';

async function cleanupRoost() {
  const db = getAdminDb();
  const versions = await db
    .collection('sites').doc(SITE_ID)
    .collection('roosts').doc(ROOST_ID)
    .collection('versions').get();
  await Promise.all(versions.docs.map((d) => d.ref.delete()));
  await db.collection('sites').doc(SITE_ID).collection('roosts').doc(ROOST_ID).delete();
}

test.beforeEach(async () => {
  await cleanupRoost();
  await seedMachine(SITE_ID, MACHINE_ID);
});

test.afterEach(async () => {
  await cleanupRoost();
});

test('a direct /roosts?roost= link opens the detail panel and keeps the param', async ({ page }) => {
  await seedRoostWithVersionHistory(SITE_ID, ROOST_ID, {
    versionCount: 2,
    descriptions: [null, 'Deep link target'],
  });

  // The whole point: navigate straight to the URL. Do NOT click the row first —
  // clicking always worked, and a click would mask the regression entirely.
  await page.goto(`/roosts?roost=${ROOST_ID}`);

  await expect(page.getByRole('heading', { name: 'roosts', exact: true })).toBeVisible();
  await expect(page.locator(`button[data-roost-row="${ROOST_ID}"]`)).toBeVisible();

  // The panel is the outcome that was lost.
  await expect(page.locator('#roost-detail-panel')).toBeVisible();

  // And the param has to survive. The bug stripped it, so a panel-only
  // assertion would still pass against a build that rewrote the URL and then
  // re-opened the panel some other way — reload would break, and the link
  // would not be shareable.
  await expect(page).toHaveURL(new RegExp(`[?&]roost=${ROOST_ID}\\b`));

  // Settle past the render where the effect used to fire, so a slow clear
  // cannot pass by racing the assertions above.
  await page.waitForTimeout(1500);
  await expect(page.locator('#roost-detail-panel')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`[?&]roost=${ROOST_ID}\\b`));
});
