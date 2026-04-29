/**
 * Screenshot — control capability card preview (api-sprint wave 4.3).
 *
 * Output: `web/public/landing-screens/control.png`
 * Used by: the landing page control capability card (wired up by wave 4.5).
 *
 * Drives the dashboard into the `control-process-restarting` scenario: one
 * machine running touchdesigner.exe with status=LAUNCHING (mid-restart), so
 * the process row shows the launching indicator. The processes panel is
 * expanded by default via the seeded user preferences (processesExpanded).
 */
import { test, expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { getAdminDb } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import { FIXED_NOW_MS, seedScreenshotFixtures } from './fixtures';

test.use(roleState('admin'));

test('control capability card preview', async ({ page }) => {
  const ctx = await seedScreenshotFixtures('control-process-restarting');

  try {
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    await page.clock.install({ time: FIXED_NOW_MS });

    await page.goto('/dashboard');

    const card = page
      .getByTestId('machine-card')
      .filter({ hasText: ctx.machineId! });
    await expect(card).toBeVisible();

    // The processes panel is expanded by default via the seeded user
    // preferences (processesExpanded: true). Wait for the touchdesigner row
    // to render so the LAUNCHING badge/spinner is visible.
    await expect(card.getByText('touchdesigner.exe', { exact: false })).toBeVisible();

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

    await page.waitForTimeout(500);

    await page.screenshot({
      path: 'public/landing-screens/control.png',
      fullPage: false,
    });
  } finally {
    await ctx.cleanup();
  }
});
