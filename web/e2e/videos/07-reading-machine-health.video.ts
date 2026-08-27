/**
 * Scene — episode 7, "reading machine health". Seven SCREEN beats, captured in
 * order.
 *
 * Rendered VO (voiceover/out/07-reading-machine-health/, ffprobe):
 *   b01 18.1s the card at a glance · b02 19.2s the color language
 *   b03 27.2s temperatures · b04 15.5s network health
 *   b05 16.8s the detail panel · b06 18.9s per-device + time range
 *   b07 17.8s what offline looks like
 *
 * Fixture: `dashboard-mixed-states`, not the `monitor-single-machine` the
 * script's front matter names. b06 needs >5 machines to trip
 * MACHINE_SWITCHER_MIN AND per-device history; mixed-states now carries both
 * (media-server-stage got 2 disks + 2 nics), plus the degraded
 * `nyc-signage-01` for b04 and the offline `touring-rig-04` for b07 — so one
 * seed covers the whole episode in one take.
 *
 * Metric tiles carry no testids, so beats target them by exact text, the same
 * selector the screenshot specs use.
 *
 * Run:  cd web && npm run videos -- --grep "episode 7"
 * Out:  dev/video-tutorials/footage/web/07-reading-machine-health.mp4
 */

import { FieldValue } from 'firebase-admin/firestore';
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

test('episode 7 — reading machine health', async ({ browser }) => {
  const ctx = await seedScreenshotFixtures('dashboard-mixed-states');
  try {
    const db = getAdminDb();
    // Auto-select the seeded site (admin is also on the baseline site-A).
    await db
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    // b03's second half needs a machine with NO cpu temperature — since 3.2.0
    // temperatures come from the PawnIO driver, and a machine without it (or
    // with `"temperature": { "enabled": false }`) reads blank while gpu temps
    // still arrive from vendor APIs. `writeMachineMetrics` always writes one, so
    // delete it here; a merge-set cannot remove a nested field.
    await db
      .collection('sites')
      .doc(ctx.siteId)
      .collection('machines')
      .doc('museum-kiosk-2')
      .update({ 'metrics.cpus.CPU0.temperature': FieldValue.delete() });

    await recordScene(
      browser,
      '07-reading-machine-health',
      { baseURL: E2E_BASE_URL, storageState: roleState('admin').storageState },
      async (page) => {
        await openForCapture(page, '/dashboard');
        await expect(page.getByTestId('machine-card')).toHaveCount(10);

        // [b01] the card at a glance — cpu/ram/disk/gpu + sparklines (~18.1s).
        // The tile the narration calls "memory" is labelled "ram" on screen; the
        // spoken word is plain english and stays, so frame the tile group rather
        // than resting on that label.
        const focusCard = page
          .getByTestId('machine-card')
          .filter({ hasText: 'media-server-stage' });
        await centerInView(page, focusCard);
        await highlight(page, focusCard, 2600);
        await narrate(page, 'b01 card at a glance', 19);

        // [b02] the color language (~19.2s) — the calm card and the hot one sit
        // far apart in the fleet, so moving between them reads as a sweep.
        const calmCard = page
          .getByTestId('machine-card')
          .filter({ hasText: 'lobby-display' });
        await centerInView(page, calmCard);
        await highlight(page, calmCard, 2200);
        await narrate(page, 'b02 colors — headroom', 9);
        await centerInView(page, focusCard);
        await highlight(page, focusCard, 2200);
        await narrate(page, 'b02 colors — pinned', 11);

        // [b03] temperatures (~27.2s) — cpu, then gpu, then the machine whose
        // cpu temperature slot is empty.
        const cpuTile = focusCard.getByText('cpu', { exact: true }).first();
        await centerInView(page, cpuTile);
        await highlight(page, cpuTile, 2400);
        await narrate(page, 'b03 temps — cpu', 9);
        const gpuTile = focusCard.getByText('gpu', { exact: true }).first();
        await centerInView(page, gpuTile);
        await highlight(page, gpuTile, 2400);
        await narrate(page, 'b03 temps — gpu + the °C/°F preference', 10);
        const noSensorCard = page
          .getByTestId('machine-card')
          .filter({ hasText: 'museum-kiosk-2' });
        await centerInView(page, noSensorCard);
        await highlight(page, noSensorCard.getByText('cpu', { exact: true }).first(), 2400);
        await narrate(page, 'b03 blank cpu temperature — no sensor driver', 9);

        // [b04] network health (~15.5s). Latency and packet loss render ONLY in
        // the COLLAPSED summary row (MachineCardView.tsx:421-431); the expanded
        // "network" tile shows the NIC id and ↑tx/↓rx, neither of which is
        // narrated. statsExpanded is a user preference shared by every card, so
        // the collapse-all control is what brings the summary row on screen.
        // nyc-signage-01 is seeded degraded — 128ms (red, >100) with 2.4% loss,
        // and the loss chip is hidden at zero.
        const collapseAll = page.locator('button:has(svg.lucide-chevrons-down-up)').first();
        await clickWithCursor(page, collapseAll);
        await page.waitForTimeout(700);
        const degradedCard = page
          .getByTestId('machine-card')
          .filter({ hasText: 'nyc-signage-01' });
        await centerInView(page, degradedCard);
        const pingChip = degradedCard.getByText(/ping/).first();
        await highlight(page, pingChip, 3000);
        await narrate(page, 'b04 ping + % loss on the collapsed row', 16);

        // Restore the expanded cards for the detail-panel beats.
        const expandAll = page.locator('button:has(svg.lucide-chevrons-up-down)').first();
        await clickWithCursor(page, expandAll);
        await page.waitForTimeout(700);

        // [b05] the detail panel (~16.8s) — clicking cpu also pulls in cpu
        // temperature, which is the "smart about pairings" line.
        const focusCardAfter = page
          .getByTestId('machine-card')
          .filter({ hasText: 'media-server-stage' });
        await clickWithCursor(page, focusCardAfter.getByText('cpu', { exact: true }).first());
        // next/dynamic mount: let it render before scrolling its header in frame.
        await page.waitForTimeout(800);
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await narrate(page, 'b05 detail panel opens', 17);

        // [b06] per-device and time range (~18.9s).
        //
        // WORDING NOTE: the narration says "tab"; the panel actually renders a
        // row of per-device TOGGLE CHIPS (C:, D:, the gpu, Ethernet 1,
        // Tailscale) rather than tabs. Same idea on screen, different noun —
        // logged rather than papered over. Frame the chip row, don't cut to
        // something that looks like a tab strip.
        const nicChip = page.getByRole('button', { name: 'Tailscale' });
        await centerInView(page, nicChip);
        await highlight(page, page.getByRole('button', { name: 'D:' }).first(), 1800);
        await highlight(page, nicChip, 1800);
        await narrate(page, 'b06 per-device chips', 7);
        const dayButton = page.getByRole('button', { name: 'day', exact: true });
        await centerInView(page, dayButton);
        await clickWithCursor(page, dayButton);
        await narrate(page, 'b06 time range — day', 5);
        // 10 machines trips MACHINE_SWITCHER_MIN=5, so the title bar grows a
        // switcher.
        const switcherTrigger = page.getByRole('button', { name: 'switch machine' });
        await centerInView(page, switcherTrigger);
        await highlight(page, switcherTrigger, 2400);
        await narrate(page, 'b06 machine switcher', 7);

        // [b07] what offline looks like (~17.8s). Close the panel first —
        // Escape does nothing, the panel has no key handler.
        await clickWithCursor(page, page.getByTestId('metrics-detail-close-button'));
        await expect(page.getByTestId('metrics-detail-close-button')).not.toBeVisible();
        const offlineCard = page
          .getByTestId('machine-card')
          .filter({ hasText: 'touring-rig-04' });
        await centerInView(page, offlineCard);
        await highlight(page, offlineCard, 2600);
        await narrate(page, 'b07 offline — red pill, stale heartbeat', 18);
      },
    );
  } finally {
    await ctx.cleanup();
  }
});
