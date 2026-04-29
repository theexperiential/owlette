/**
 * Screenshot — display capability card preview (api-sprint wave 4.4).
 *
 * Output: `web/public/landing-screens/preview-displays.png`
 * Used by:  `components/landing/UseCaseSection.tsx` (display capability card).
 *
 * Drives the dashboard's display layout panel into a 4-monitor 2×2 mosaic
 * topology and screenshots the result. Mirrors the access-control display-
 * panel spec (`e2e/specs/access-control/display-panel.spec.ts`) for the
 * UI flow — list view → "view displays" button on the seeded machine row →
 * panel slides open — because that path is the one already proven stable
 * by the regression suite.
 */
import { test, expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { getAdminDb } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import { FIXED_NOW_MS, seedScreenshotFixtures } from './fixtures';

test.use(roleState('admin'));

test('display capability card preview', async ({ page }) => {
  const ctx = await seedScreenshotFixtures('display-layout-editor');

  try {
    // The dashboard auto-selects `lastSiteId` from the user doc when present.
    // Pin it to the seeded screenshot site so /dashboard loads the right
    // machine list without going through the site-switcher dropdown.
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    // Pin the clock so any "x minutes ago" / countdown text is stable.
    // Install BEFORE goto so the page's own Date.now() picks up the fake.
    await page.clock.install({ time: FIXED_NOW_MS });

    await page.goto('/dashboard');

    // Open the display panel via the list view's one-click "view displays"
    // button — same path as the access-control display-panel regression.
    await page.getByTestId('view-toggle-list').click();
    const row = page
      .getByTestId('machine-row')
      .filter({ hasText: ctx.machineId! });
    await row.getByTestId('open-display-panel').click();

    const panel = page.getByTestId('display-layout-panel');
    await expect(panel).toBeVisible();

    // Wait for the network to settle so any late-paint (4-monitor canvas
    // render after the display profile snapshot resolves) finishes before
    // we capture pixels.
    await page.waitForLoadState('networkidle');

    // Disable CSS animations + transitions so cycling effects (panel slide,
    // monitor card fade-ins) don't introduce per-run jitter.
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

    // Pin the clock inside the page once more after navigation so any
    // hooks that captured Date.now() at mount get the fixed anchor on
    // their next render tick.
    await page.clock.setFixedTime(FIXED_NOW_MS);

    await page.screenshot({
      path: 'public/landing-screens/preview-displays.png',
      fullPage: false,
    });
  } finally {
    await ctx.cleanup();
  }
});
