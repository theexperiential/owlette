/**
 * Scene — episode 6, "reading machine health".
 *
 * Every beat in this script is a SCREEN beat (no B-ROLL), so the scene captures
 * all seven in order. Rendered VO durations (voiceover/out/06-reading-machine-health/):
 *   b01 ≈ 18.1s — the card at a glance (a single card framed)
 *   b02 ≈ 19.2s — the color language (pan across cards at different usage levels)
 *   b03 ≈ 19.9s — temperatures (point at cpu / gpu temp tiles)
 *   b04 ≈ 15.5s — network health (point at the network latency row)
 *   b05 ≈ 16.8s — the detail panel (click cpu tile → MetricsDetailPanel opens)
 *   b06 ≈ 18.9s — per-device tabs and time range (panel tabs + machine switcher)
 *   b07 ≈ 17.8s — what offline looks like (the offline touring-rig-04 card)
 *
 * Fixture: the script's front matter pins `monitor-single-machine` (4 machines),
 * but the NOTEs on b06 and b07 explicitly say to use `dashboard-mixed-states` for
 * those beats — b06 needs >5 machines for the title-bar machine switcher (the
 * MACHINE_SWITCHER_MIN gate in MetricsDetailPanel), and b07 needs the offline
 * `touring-rig-04` card. dashboard-mixed-states gives us all of that AND still
 * has `media-server-stage` (alerting state) for b01–b05, so the whole episode
 * captures cleanly off a single fixture seed — same pattern as ep01.
 *
 * Selectors mirror the screenshot specs:
 *   machine-card           — MachineCardView's root testid
 *   getByText('cpu',true)  — clicks the CPU metric tile (matches monitor.spec.ts)
 * The per-tile divs aren't testid'd, so the screenshot harness's exact-text match
 * is the proven selector.
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
    // Auto-select the seeded site on load (admin is also on the baseline site-A).
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

        // [b01] the card at a glance — frame the media-server-stage card so the
        // cpu / ram / disk / gpu rows + sparklines are all visible (~18.1s VO).
        const focusCard = page
          .getByTestId('machine-card')
          .filter({ hasText: 'media-server-stage' });
        await centerInView(page, focusCard);
        await highlight(page, focusCard, 2600);
        await narrate(page, 'b01 card at a glance', 18);

        // [b02] the color language — pan across two cards at very different
        // usage levels: the alerting media-server-stage (red/amber tiles) and
        // the calm lobby-display (green tiles) sit far apart in the fleet so a
        // scroll between them reads as the eye sweeping the dashboard (~19.2s).
        const calmCard = page
          .getByTestId('machine-card')
          .filter({ hasText: 'lobby-display' });
        await centerInView(page, calmCard);
        await highlight(page, calmCard, 2200);
        await narrate(page, 'b02 colors — calm card', 8);
        await centerInView(page, focusCard);
        await highlight(page, focusCard, 2200);
        await narrate(page, 'b02 colors — hot card', 11);

        // [b03] temperatures — the cpu/gpu temp readouts live inside the
        // metric tiles on the focused card. Highlight the cpu row first, then
        // the gpu row (~19.9s VO). The tiles themselves don't have testids,
        // so we target by the leading metric label — exact match, as in
        // monitor.spec.ts — and walk the DOM up to the row div to highlight.
        const cpuTile = focusCard.getByText('cpu', { exact: true }).first();
        await centerInView(page, cpuTile);
        await highlight(page, cpuTile, 2400);
        await narrate(page, 'b03 temps — cpu', 9);
        const gpuTile = focusCard.getByText('gpu', { exact: true }).first(); // VERIFY: same exact-text pattern, GPU tile sits under the cpu/ram/disk rows
        await centerInView(page, gpuTile);
        await highlight(page, gpuTile, 2400);
        await narrate(page, 'b03 temps — gpu', 11);

        // [b04] network health — the network row sits at the bottom of the
        // metric tiles (latency + tx/rx throughput). Same label-targeted hit
        // as the others (~15.5s VO).
        const netTile = focusCard.getByText('network', { exact: true }).first(); // VERIFY: network row label, last tile in the metric stack
        await centerInView(page, netTile);
        await highlight(page, netTile, 2400);
        await narrate(page, 'b04 network', 15);

        // [b05] the detail panel — click the cpu tile, the MetricsDetailPanel
        // slides in above the machines list. Same path as monitor.spec.ts:
        // `card.getByText('cpu', { exact: true }).first().click()` (~16.8s VO).
        await clickWithCursor(page, cpuTile);
        // Panel mounts dynamically (next/dynamic) — give it a beat to render
        // before scrolling back to the top so the panel's header is in frame.
        await page.waitForTimeout(800);
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await narrate(page, 'b05 detail panel opens', 16);

        // [b06] per-device tabs and time range — with 10 machines the panel's
        // title bar grows a machine switcher (MACHINE_SWITCHER_MIN=5 inside
        // MetricsDetailPanel), and the TimeRangeSelector renders buttons
        // labeled hour / day / week / month / year / all. Highlight the day
        // button to show the user can zoom out, then the switcher itself
        // (~18.9s VO).
        const dayButton = page.getByRole('button', { name: 'day', exact: true }); // VERIFY: TimeRangeSelector renders <Button>day</Button>; accessible name is the label
        await centerInView(page, dayButton);
        await highlight(page, dayButton, 2400);
        await narrate(page, 'b06 time range — day', 8);
        const switcherTrigger = page.getByRole('button', { name: 'switch machine' }); // VERIFY: MetricsDetailPanel's MachineSwitcher uses aria-label="switch machine"
        await centerInView(page, switcherTrigger);
        await highlight(page, switcherTrigger, 2400);
        await narrate(page, 'b06 machine switcher', 11);

        // [b07] what offline looks like — close the detail panel by scrolling
        // down to the fleet and frame the offline touring-rig-04 card. The
        // dashboard-mixed-states seed marks it offline (lastHeartbeat 600s
        // ago, online=false), so the red 'offline' pill and stale heartbeat
        // chip read in frame (~17.8s VO).
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
