/**
 * Scene — episode 4, "the dashboard, end to end". All SCREEN beats, no B-ROLL.
 *
 * Rendered VO (voiceover/out/04-dashboard-tour/, ffprobe):
 *   b01 21.1s orientation · b02 22.6s the machines section
 *   b03 29.2s reading a single card · b04 15.3s card view vs list view
 *   b05 19.5s expand, collapse, detail panel · b06 29.3s the rest of the app
 * b02, b03 and b06 were revoiced for the v2 series; their dwells are derived
 * from the current MP3s.
 *
 * Runs on the screenshots harness: `dashboard-mixed-states` (10 machines, one
 * offline, nine managed processes across five of them) + admin storageState,
 * selectors as in the screenshot specs.
 *
 * Run:  cd web && npm run videos -- --grep "episode 4"
 * Out:  dev/video-tutorials/footage/web/04-dashboard-tour.mp4
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
  slowScrollToBottom,
  centerInView,
  clickWithCursor,
} from './video-helpers';

test('episode 4 — the dashboard, end to end', async ({ browser }) => {
  const ctx = await seedScreenshotFixtures('dashboard-mixed-states');
  try {
    // Auto-select the seeded site on load (admin is also on the baseline site-A).
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    await recordScene(
      browser,
      '04-dashboard-tour',
      { baseURL: E2E_BASE_URL, storageState: roleState('admin').storageState },
      async (page) => {
        await openForCapture(page, '/dashboard');
        await expect(page.getByTestId('machine-card')).toHaveCount(10);

        // [b01] orientation — site-switcher breadcrumb, then the two stat tiles
        // (~21.1s). The fixture now seeds managed processes, so the "processes"
        // tile reads 9 rather than the 0 this beat used to narrate over.
        const siteSwitcher = page.getByTestId('site-switcher-trigger');
        await highlight(page, siteSwitcher, 1800);
        await narrate(page, 'b01 site switcher', 7);
        // Stat labels carry no testid; the lowercase caption under each number
        // is the only handle. `online` also appears on machine pills, so the
        // first match is the tile — which is what renders above the grid.
        const onlineTile = page.getByText('online', { exact: true }).first();
        await highlight(page, onlineTile, 1600);
        await narrate(page, 'b01 online tile', 7);
        const processesTile = page.getByText('processes', { exact: true }).first();
        await highlight(page, processesTile, 1600);
        await narrate(page, 'b01 processes tile', 8);

        // [b02] the machines section — slow pan across the card grid (~22.6s).
        // Five colour bands, not three (lib/usageColorUtils.ts:8-20). The
        // narration describes headroom vs pinned, so shoot it as it renders —
        // no grading toward a green→red ramp.
        await slowScrollToBottom(page, 16);
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await narrate(page, 'b02 machines section — rest at top', 8);

        // [b03] reading a single card, top to bottom (~29.2s). Render order is
        // pill → metric tiles (cpu, ram, disk, gpu, network) → displays → the
        // process list: MachineCardView.tsx:646 vs :750, so displays sits ABOVE
        // processes. The second tile's on-screen label is "ram", not "memory".
        const focusCard = page
          .getByTestId('machine-card')
          .filter({ hasText: 'media-server-stage' });
        await centerInView(page, focusCard);
        await highlight(page, focusCard, 2600);
        await narrate(page, 'b03 card — pill and metrics', 15);
        const processList = focusCard.getByText('TouchDesigner.exe', { exact: false }).first();
        await centerInView(page, processList);
        await highlight(page, processList, 2600);
        await narrate(page, 'b03 card — displays then processes', 15);

        // [b04] card view vs list view — toggle to list, then back (~15.3s).
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await clickWithCursor(page, page.getByTestId('view-toggle-list'));
        await expect(page.getByTestId('machine-row').first()).toBeVisible();
        await narrate(page, 'b04 list view', 8);
        // Icon-only button whose label lives in a Radix Tooltip portal: no
        // aria-label, and role+name can't resolve before the cursor hovers. Use
        // the repo's lucide svg-class pattern instead (cf. admin/webhooks.spec.ts).
        const cardToggle = page.locator('button:has(svg.lucide-layout-grid)').first();
        await clickWithCursor(page, cardToggle);
        await expect(page.getByTestId('machine-card').first()).toBeVisible();
        await narrate(page, 'b04 back to cards', 8);

        // [b05] expand/collapse-all + the metrics detail panel (~19.5s).
        // Tooltip-only name again, so same svg-class pattern. processesExpanded
        // defaults true, so the toggle loads in "collapse all" state: click
        // collapses (hiding the cpu tile), second click restores it.
        const collapseAll = page.locator('button:has(svg.lucide-chevrons-down-up)').first();
        await clickWithCursor(page, collapseAll);
        await page.waitForTimeout(600);
        const expandAll = page.locator('button:has(svg.lucide-chevrons-up-down)').first();
        await clickWithCursor(page, expandAll);
        await page.waitForTimeout(600);
        await narrate(page, 'b05 toggle expand-all', 5);
        // Tap the focus card's cpu tile to slide the detail panel open.
        const focusCardAfter = page
          .getByTestId('machine-card')
          .filter({ hasText: 'media-server-stage' });
        await clickWithCursor(page, focusCardAfter.getByText('cpu', { exact: true }).first());
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await narrate(page, 'b05 detail panel open', 14);

        // [b06] the rest of the app — the page switcher's six destinations
        // (~29.3s): dashboard, hoot, talons, roost, deploy, logs. The nav label
        // is "hoot" (PageHeader.tsx:39-43); nothing in the UI reads "cortex".
        //
        // Close the detail panel FIRST so the header sits near the top. Escape
        // does nothing here — MetricsDetailPanel has no key handler, and the
        // line that used to press it left the panel open through this beat.
        await clickWithCursor(page, page.getByTestId('metrics-detail-close-button'));
        await expect(page.getByTestId('metrics-detail-close-button')).not.toBeVisible();
        await page.waitForTimeout(400);

        // The page-switcher trigger is the second breadcrumb button; it renders
        // the current page name lowercase with a chevron.
        const pageSelector = page.getByRole('button', { name: /^dashboard$/i });
        await clickWithCursor(page, pageSelector);
        await page.waitForTimeout(500);
        const navItems = ['hoot', 'talons', 'roost', 'deploy', 'logs'];
        await narrate(page, 'b06 nav dropdown opens', 6);
        for (const name of navItems) {
          const item = page.getByRole('menuitem').filter({ hasText: new RegExp(`^${name}`) }).first();
          await highlight(page, item, 1400);
          await narrate(page, `b06 nav — ${name}`, 4);
        }
        await narrate(page, 'b06 hand-off to episode 5', 4);
      },
    );
  } finally {
    await ctx.cleanup();
  }
});
