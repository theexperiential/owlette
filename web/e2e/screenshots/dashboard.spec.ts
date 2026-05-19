/**
 * Screenshot — dashboard capability card preview (api-sprint wave 4.3).
 *
 * Output: `web/public/landing-screens/dashboard.png`
 * Used by: the landing page hero / dashboard capability card (wired up by
 * wave 4.5).
 *
 * Drives the dashboard into the `dashboard-mixed-states` scenario: 10 seeded
 * machines covering running / alerting / offline / just-restarted, then
 * flips to list view (denser, more legible at the page-hero scale) and
 * captures the result.
 */
import { test, expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { getAdminDb } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import { FIXED_NOW_MS, seedScreenshotFixtures } from './fixtures';

// Hero shot — explicitly higher res than the capability-preview default
// (1280×720) since the dashboard image is the LCP asset and gets a 3D-tilt
// treatment in the value-prop section. 1920×1080 keeps the dashboard
// content close to the table width without wasting horizontal margin.
test.use({ ...roleState('admin'), viewport: { width: 1920, height: 1080 } });

test('dashboard capability card preview', async ({ page }) => {
  const ctx = await seedScreenshotFixtures('dashboard-mixed-states');

  try {
    // Pin lastSiteId so /dashboard auto-selects the screenshot site instead
    // of the baseline `site-A` the admin user is also assigned to.
    // Also collapse the per-machine process panels so list rows render as
    // single dense rows instead of expanded accordions — the global
    // seedUser default is `processesExpanded: true`, but for the hero shot
    // we want a tight, scannable list.
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .update({ 'preferences.processesExpanded': false });

    // Pin the clock BEFORE goto so any "x minutes ago" / heartbeat-age text
    // resolves against FIXED_NOW.
    await page.clock.install({ time: FIXED_NOW_MS });

    await page.goto('/dashboard');

    // Wait for the default card grid to render so we know the dashboard is
    // populated, then flip to list view for the hero screenshot.
    await expect(page.getByTestId('machine-card')).toHaveCount(10);
    await page.getByTestId('view-toggle-list').click();
    await expect(page.getByTestId('machine-row')).toHaveCount(10);

    // Let any late-paint (sparkline series, metric badges) settle.
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
