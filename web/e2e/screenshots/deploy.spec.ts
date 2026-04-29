/**
 * Screenshot — deploy capability card preview (api-sprint wave 4.3).
 *
 * Output: `web/public/landing-screens/preview-deploy.png`
 * Used by: the landing page deploy capability card (wired up by wave 4.5).
 *
 * Drives the deployments page into the `deploy-roost-rolling` scenario:
 * a roost with 4 versions and an in-flight rollout where 3 of 10 targets
 * have completed, 1 is installing, and 6 are pending. The seeded site is
 * tier=pro so the roosts/deployments UI is unblocked.
 */
import { test, expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { getAdminDb } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import { FIXED_NOW_MS, seedScreenshotFixtures } from './fixtures';

test.use(roleState('admin'));

test('deploy capability card preview', async ({ page }) => {
  const ctx = await seedScreenshotFixtures('deploy-roost-rolling');

  try {
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    // Pin the clock BEFORE goto so any "started Xm ago" timestamps and the
    // rollout's createdAt-relative copy resolve against FIXED_NOW.
    await page.clock.install({ time: FIXED_NOW_MS });

    await page.goto('/deployments');

    // Wait for the seeded in-flight deployment row to render. The deployment
    // name `stage show v4` is rendered as plain text inside each row.
    await expect(page.getByText('stage show v4', { exact: false })).toBeVisible();

    await page.waitForLoadState('networkidle');

    await page.addStyleTag({
      content: `
        *, *::before, *::after {
          animation-duration: 0s !important;
          animation-delay: 0s !important;
          transition-duration: 0s !important;
          transition-delay: 0s !important;
        }
      `,
    });

    await page.clock.setFixedTime(FIXED_NOW_MS);

    // Progress bars / per-target status pills can paint a frame after the
    // deployment row mounts; let them settle before capture.
    await page.waitForTimeout(500);

    await page.screenshot({
      path: 'public/landing-screens/preview-deploy.png',
      fullPage: false,
    });
  } finally {
    await ctx.cleanup();
  }
});
