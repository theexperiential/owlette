/**
 * Screenshot — automate capability card preview (api-sprint wave 4.3).
 *
 * Output: `web/public/landing-screens/preview-automate.png`
 * Used by: the landing page automate capability card (wired up by wave 4.5).
 *
 * Drives the schedule editor (`/admin/schedules`) into the
 * `automate-schedule-editor` scenario: a custom "museum hours" preset on
 * top of the built-ins, plus a reboot schedule on the lobby display and an
 * alert rule for the media-server-stage CPU. Captures the preset list view
 * which surfaces the WeekSummaryBar visualization for each preset.
 */
import { test, expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { getAdminDb } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import { FIXED_NOW_MS, seedScreenshotFixtures } from './fixtures';

test.use(roleState('admin'));

test('automate capability card preview', async ({ page }) => {
  const ctx = await seedScreenshotFixtures('automate-schedule-editor');

  try {
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    // Pin the clock BEFORE goto so any "updated Xd ago" / "createdAt"
    // copy resolves against FIXED_NOW.
    await page.clock.install({ time: FIXED_NOW_MS });

    await page.goto('/admin/schedules');

    // Wait for the seeded custom preset row to render — confirms the
    // useSchedulePresets hook resolved against the screenshot site.
    await expect(page.getByText('museum hours', { exact: false })).toBeVisible();

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

    // The WeekSummaryBar paints SVG blocks after the preset doc resolves;
    // give it a beat before screenshotting.
    await page.waitForTimeout(500);

    await page.screenshot({
      path: 'public/landing-screens/preview-automate.png',
      fullPage: false,
    });
  } finally {
    await ctx.cleanup();
  }
});
