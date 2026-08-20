/**
 * Screenshot — the landing page's automate capability card.
 * Output: `web/public/landing-screens/preview-automate.png`.
 *
 * Drives `/admin/schedules` into the `automate-schedule-editor` scenario (a
 * custom "museum hours" preset over the built-ins, a lobby reboot schedule, a
 * media-server-stage CPU alert) and captures the preset list, which is where
 * the WeekSummaryBar renders.
 */
import { test, expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { getAdminDb } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import { FIXED_NOW_MS, seedScreenshotFixtures } from './fixtures';

// /admin/schedules is RequireSuperadmin — a plain admin gets redirected.
test.use(roleState('superadmin'));

test('automate capability card preview', async ({ page }) => {
  const ctx = await seedScreenshotFixtures('automate-schedule-editor');

  try {
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.superadmin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    // Pin the clock BEFORE goto so "updated Xd ago" resolves against FIXED_NOW.
    await page.clock.install({ time: FIXED_NOW_MS });

    await page.goto('/admin/schedules');

    // Proves useSchedulePresets resolved against the screenshot site.
    await expect(page.getByText('museum hours', { exact: false })).toBeVisible();

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

    // WeekSummaryBar paints its SVG after the preset doc resolves.
    await page.waitForTimeout(500);

    await page.screenshot({
      path: 'public/landing-screens/preview-automate.png',
      fullPage: false,
    });
  } finally {
    await ctx.cleanup();
  }
});
