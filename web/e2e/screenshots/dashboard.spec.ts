/**
 * Screenshot — dashboard capability card preview (api-sprint wave 4.3).
 *
 * Output: `web/public/landing-screens/dashboard.png`
 * Used by: the landing page hero / dashboard capability card (wired up by
 * wave 4.5).
 *
 * Drives the dashboard into the `dashboard-mixed-states` scenario: 10 seeded
 * machines covering running / alerting / offline / just-restarted, then
 * captures the default card grid view.
 */
import { test, expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { getAdminDb } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import { FIXED_NOW_MS, seedScreenshotFixtures } from './fixtures';

test.use(roleState('admin'));

test('dashboard capability card preview', async ({ page }) => {
  const ctx = await seedScreenshotFixtures('dashboard-mixed-states');

  try {
    // Pin lastSiteId so /dashboard auto-selects the screenshot site instead
    // of the baseline `site-A` the admin user is also assigned to.
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    // Pin the clock BEFORE goto so any "x minutes ago" / heartbeat-age text
    // resolves against FIXED_NOW.
    await page.clock.install({ time: FIXED_NOW_MS });

    await page.goto('/dashboard');

    // Wait for all 10 seeded machine cards to render before screenshotting.
    await expect(page.getByTestId('machine-card')).toHaveCount(10);

    // Let any late-paint (sparkline series, metric badges) settle.
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

    // Re-pin Date.now() after navigation so any hook that captured it at
    // mount has the fixed anchor on its next render tick.
    await page.clock.setFixedTime(FIXED_NOW_MS);

    // Sparkline charts read historical_metrics asynchronously; give them a
    // beat to paint after networkidle.
    await page.waitForTimeout(500);

    await page.screenshot({
      path: 'public/landing-screens/dashboard.png',
      fullPage: false,
    });
  } finally {
    await ctx.cleanup();
  }
});
