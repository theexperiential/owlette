/**
 * Screenshot — display section storyboard (api-sprint wave 4.4).
 *
 * Output:
 *   - `web/public/landing-screens/displays-frame-1.png` (drift detected, apply CTA)
 *   - `web/public/landing-screens/displays-frame-2.png` (mid-apply, countdown)
 *   - `web/public/landing-screens/displays-frame-3.png` (ack received, drift cleared)
 *
 * Used by: `components/landing/DisplaySection.tsx` storyboard frames (wired
 * up by wave 4.5).
 *
 * The three frames must be visually consistent — same site/machine ids,
 * same viewport, same monitor topology. Only the per-frame state differs:
 *   1. drift detected (displayDriftCount=2)
 *   2. apply in flight (remoteApply.scheduledAt = FIXED_NOW + 25s)
 *   3. ack received (lastAppliedAt set, drift cleared)
 *
 * Each `seedScreenshotFixtures` call performs a full emulator reset and
 * re-seed, which is what makes consecutive frames safe in one test. We
 * still call `cleanup()` once in `finally` so the emulator returns to a
 * clean state if subsequent specs share the run.
 */
import { test, expect, type Page } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { getAdminDb } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import {
  FIXED_NOW_MS,
  seedScreenshotFixtures,
  type ScreenshotFixture,
  type ScreenshotScenario,
} from './fixtures';

test.use(roleState('admin'));

const FRAMES: { scenario: ScreenshotScenario; output: string }[] = [
  { scenario: 'display-storyboard-frame-1', output: 'public/landing-screens/displays-frame-1.png' },
  { scenario: 'display-storyboard-frame-2', output: 'public/landing-screens/displays-frame-2.png' },
  { scenario: 'display-storyboard-frame-3', output: 'public/landing-screens/displays-frame-3.png' },
];

/**
 * Inject animation-disabling CSS for the current page. Re-applied on each
 * frame because page navigation drops the previous style tag.
 */
async function disableAnimations(page: Page): Promise<void> {
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
}

/**
 * Open the display panel for the seeded storyboard machine via the list-view
 * "view displays" button — the same path the access-control display-panel
 * regression spec proves stable.
 */
async function openDisplayPanel(page: Page, machineId: string): Promise<void> {
  await page.getByTestId('view-toggle-list').click();
  const row = page.getByTestId('machine-row').filter({ hasText: machineId });
  await row.getByTestId('open-display-panel').click();
  await expect(page.getByTestId('display-layout-panel')).toBeVisible();
}

test('display section storyboard — three frames', async ({ page }) => {
  // Pin the clock once for the whole test. Install BEFORE the first goto
  // so the page's own Date.now()/setInterval callsites pick up the fake.
  await page.clock.install({ time: FIXED_NOW_MS });

  let ctx: ScreenshotFixture | undefined;

  try {
    for (const { scenario, output } of FRAMES) {
      // Each seed call fully resets the emulator + re-seeds the baseline,
      // so we don't need to call cleanup() between frames — the next seed
      // wipes the previous state.
      ctx = await seedScreenshotFixtures(scenario);

      // Pin lastSiteId so /dashboard auto-selects the storyboard site
      // instead of the baseline `site-A` the admin user is also assigned
      // to. Re-applied each frame because the emulator reset zeroes it.
      await getAdminDb()
        .collection('users')
        .doc(TEST_USERS.admin.uid)
        .set({ lastSiteId: ctx.siteId }, { merge: true });

      await page.goto('/dashboard');
      await openDisplayPanel(page, ctx.machineId!);

      // Let any late-paint (display canvas render after profile snapshot
      // resolves, banner mount, countdown render) settle before capture.
      // dashboard has persistent firestore websockets — network never idles. wait for paint instead.
    await page.waitForTimeout(1500);
      await disableAnimations(page);

      // Re-pin Date.now() after navigation so any hook that captured it
      // at mount has the fixed anchor on its next render tick (e.g. the
      // ack-banner countdown reads Date.now() against scheduledAt).
      await page.clock.setFixedTime(FIXED_NOW_MS);

      await page.screenshot({ path: output, fullPage: false });
    }
  } finally {
    if (ctx) {
      await ctx.cleanup();
    }
  }
});
