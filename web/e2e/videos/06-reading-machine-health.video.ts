/**
 * Scene — episode 6, "reading machine health". Seven SCREEN beats, captured in
 * order; the narrate() durations match the rendered VO in
 * voiceover/out/06-reading-machine-health/.
 *
 * Fixture: `dashboard-mixed-states`, not the `monitor-single-machine` the
 * script's front matter names. b06 needs >5 machines to trip
 * MACHINE_SWITCHER_MIN in MetricsDetailPanel and b07 needs the offline
 * `touring-rig-04`; mixed-states has both plus the alerting
 * `media-server-stage` for b01-b05, so one seed covers the episode.
 *
 * Metric tiles carry no testids, so beats target them by exact text, the same
 * selector the screenshot specs use.
 *
 * Run:  cd web && npm run videos -- --grep "episode 6"
 * Out:  web/e2e/.output/videos/06-reading-machine-health.mp4
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { getAdminDb, E2E_BASE_URL } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import { seedScreenshotFixtures } from '../screenshots/fixtures';
import {
  recordScene,
  openForCapture,
  narrate,
  highlight,
  centerInView,
  clickWithCursor,
} from './video-helpers';

test('episode 6 — reading machine health', async ({ browser }) => {
  const ctx = await seedScreenshotFixtures('dashboard-mixed-states');
  try {
    // Auto-select the seeded site (admin is also on the baseline site-A).
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    await recordScene(
      browser,
      '06-reading-machine-health',
      { baseURL: E2E_BASE_URL, storageState: roleState('admin').storageState },
      async (page) => {
        await openForCapture(page, '/dashboard');
        await expect(page.getByTestId('machine-card')).toHaveCount(10);

        // [b01] the card at a glance — cpu/ram/disk/gpu rows + sparklines in frame.
        const focusCard = page
          .getByTestId('machine-card')
          .filter({ hasText: 'media-server-stage' });
        await centerInView(page, focusCard);
        await highlight(page, focusCard, 2600);
        await narrate(page, 'b01 card at a glance', 18);

        // [b02] the color language — the alerting card and the calm one sit far
        // apart in the fleet, so scrolling between them reads as a sweep.
        const calmCard = page
          .getByTestId('machine-card')
          .filter({ hasText: 'lobby-display' });
        await centerInView(page, calmCard);
        await highlight(page, calmCard, 2200);
        await narrate(page, 'b02 colors — calm card', 8);
        await centerInView(page, focusCard);
        await highlight(page, focusCard, 2200);
        await narrate(page, 'b02 colors — hot card', 11);

        // [b03] temperatures — cpu row, then gpu row.
        const cpuTile = focusCard.getByText('cpu', { exact: true }).first();
        await centerInView(page, cpuTile);
        await highlight(page, cpuTile, 2400);
        await narrate(page, 'b03 temps — cpu', 9);
        const gpuTile = focusCard.getByText('gpu', { exact: true }).first();
        await centerInView(page, gpuTile);
        await highlight(page, gpuTile, 2400);
        await narrate(page, 'b03 temps — gpu', 11);

        // [b04] network health — latency + tx/rx, last tile in the stack.
        const netTile = focusCard.getByText('network', { exact: true }).first();
        await centerInView(page, netTile);
        await highlight(page, netTile, 2400);
        await narrate(page, 'b04 network', 15);

        // [b05] the detail panel — the cpu tile opens MetricsDetailPanel above
        // the machines list.
        await clickWithCursor(page, cpuTile);
        // next/dynamic mount: let it render before scrolling its header in frame.
        await page.waitForTimeout(800);
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await narrate(page, 'b05 detail panel opens', 16);

        // [b06] per-device tabs and time range — 10 machines trips
        // MACHINE_SWITCHER_MIN=5, so the title bar grows a switcher. Zoom out
        // via the day button first, then point at the switcher.
        const dayButton = page.getByRole('button', { name: 'day', exact: true });
        await centerInView(page, dayButton);
        await highlight(page, dayButton, 2400);
        await narrate(page, 'b06 time range — day', 8);
        const switcherTrigger = page.getByRole('button', { name: 'switch machine' });
        await centerInView(page, switcherTrigger);
        await highlight(page, switcherTrigger, 2400);
        await narrate(page, 'b06 machine switcher', 11);

        // [b07] what offline looks like — scroll past the panel to
        // touring-rig-04, seeded offline (lastHeartbeat 600s ago), so the red
        // pill and stale-heartbeat chip are in frame.
        const offlineCard = page
          .getByTestId('machine-card')
          .filter({ hasText: 'touring-rig-04' });
        await centerInView(page, offlineCard);
        await highlight(page, offlineCard, 2600);
        await narrate(page, 'b07 offline', 18);
      },
    );
  } finally {
    await ctx.cleanup();
  }
});
