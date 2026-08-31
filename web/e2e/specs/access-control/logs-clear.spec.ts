/**
 * Access-control — the logs page's `clear logs` button is hidden from anyone failing
 * `isSiteAdmin(siteId)`. DELETE /api/sites/{siteId}/logs is gated on
 * Capability.SITE_LOGS_MANAGE (app/api/sites/[siteId]/logs/route.ts), which members
 * do not hold, so rendering the control only bought them a silent 403.
 *
 * Both roles are asserted: the admin case is the negative control that proves the
 * selector finds a real button when the gate passes.
 */

import { test, expect, type Page } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { seedLogEvents } from '../../helpers/coverageSeed';

const SITE_ID = 'site-A';

test.beforeEach(async () => {
  // Rows must exist: the button is also `disabled` on an empty feed, so seeding keeps
  // "hidden" the only reason a member can't see it.
  await seedLogEvents(SITE_ID);
});

/** Land on /logs with site-A selected, switching if a persisted lastSiteId differs. */
async function gotoSiteALogs(page: Page) {
  await page.goto('/logs');
  await expect(page.getByRole('heading', { name: /^logs$/i })).toBeVisible();

  const siteSwitcher = page.getByTestId('site-switcher-trigger');
  await expect(siteSwitcher).toBeVisible();
  if (!((await siteSwitcher.textContent()) ?? '').includes('Site A')) {
    await siteSwitcher.click();
    await page.getByRole('menuitem', { name: /Site A \(Assigned\)/ }).click();
    await expect(siteSwitcher).toContainText('Site A');
  }
}

test.describe('logs — member on site-A', () => {
  test.use(roleState('member'));

  test('clear logs is hidden', async ({ page }) => {
    await gotoSiteALogs(page);
    await expect(page.getByTestId('log-row-e2e-log-crash')).toBeVisible();

    await expect(page.getByTestId('logs-clear')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^clear logs$/i })).toHaveCount(0);
  });
});

test.describe('logs — admin on site-A', () => {
  test.use(roleState('admin'));

  test('clear logs is shown and enabled', async ({ page }) => {
    await gotoSiteALogs(page);
    await expect(page.getByTestId('log-row-e2e-log-crash')).toBeVisible();

    await expect(page.getByTestId('logs-clear')).toBeVisible();
    await expect(page.getByTestId('logs-clear')).toBeEnabled();
  });
});
