/**
 * Screenshot — deploy capability card preview (api-sprint wave 4.3).
 *
 * Output: `web/public/landing-screens/preview-deploy.png`
 * Used by: the landing page deploy capability card (wired up by wave 4.5).
 *
 * Drives the deployments page into the `deploy-roost-rolling` scenario:
 * a roost with 4 versions, an in-flight rollout where 3 of 10 targets have
 * completed and 1 is installing, plus three sibling deployments at
 * different statuses (completed / failed / scheduled) so the list reads as
 * an active deployment surface. The in-flight row is expanded to show its
 * per-target progress before capture.
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
    const inFlightRow = page.getByText('stage show v4', { exact: false });
    await expect(inFlightRow).toBeVisible();

    // Expand the in-flight row so the per-target progress (3 completed,
    // 1 installing at 64%, 6 pending) is visible — the user wanted to see
    // the deployment "expanded" to show it actively rolling out.
    await inFlightRow.click();

    // dashboard has persistent firestore websockets — network never idles. wait for paint instead.
    await page.waitForTimeout(1500);

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
