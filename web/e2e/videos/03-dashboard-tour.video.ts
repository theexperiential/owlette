/**
 * Scene — episode 3, "the dashboard, end to end".
 *
 * Every beat in this episode is a SCREEN beat (web capture). No B-ROLL to skip.
 * Beats and their rendered VO durations (voiceover/out/03-dashboard-tour/):
 *   b01 ≈ 21.1s — orientation (site-switcher breadcrumb + online + processes stat tiles)
 *   b02 ≈ 19.1s — the machines section (slow pan across the seeded fleet)
 *   b03 ≈ 26.2s — reading a single card (frame media-server-stage)
 *   b04 ≈ 15.3s — card vs list view (toggle list, then back)
 *   b05 ≈ 19.5s — expand/collapse-all + the metrics detail panel
 *   b06 ≈ 25.7s — the rest of the app (open the page-selector dropdown)
 *
 * Reuses the screenshots harness verbatim: the `dashboard-mixed-states` fixture
 * (10 seeded machines, one offline, varied usage) + the admin role storageState.
 * Selectors mirror the screenshot specs (machine-card, view-toggle-list,
 * machine-row, site-switcher-trigger, the 'media-server-stage' card, the 'cpu'
 * metric tile).
 *
 * Run:  cd web && npm run videos -- --grep "episode 3"
 * Out:  web/e2e/.output/videos/03-dashboard-tour.mp4
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

test('episode 3 — the dashboard, end to end', async ({ browser }) => {
  const ctx = await seedScreenshotFixtures('dashboard-mixed-states');
  try {
    // Auto-select the seeded site on load (admin is also on the baseline site-A).
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    await recordScene(
      browser,
      '03-dashboard-tour',
      { baseURL: E2E_BASE_URL, storageState: roleState('admin').storageState },
      async (page) => {
        await openForCapture(page, '/dashboard');
        await expect(page.getByTestId('machine-card')).toHaveCount(10);

        // [b01] orientation — site-switcher breadcrumb, then the online + processes tiles (~21.1s).
        const siteSwitcher = page.getByTestId('site-switcher-trigger');
        await highlight(page, siteSwitcher, 1800);
        // Quick eye-pull to the "9 / 10 online" stat tile.
        const onlineTile = page.getByText('online', { exact: true }).first(); // VERIFY: stat label has no testid; matches the lowercased "online" caption under the stat number
        await highlight(page, onlineTile, 1600);
        const processesTile = page.getByText('processes', { exact: true }).first(); // VERIFY: stat label match; the page also renders an h3 "machines" but no h3 "processes"
        await highlight(page, processesTile, 1600);
        await narrate(page, 'b01 orientation', 21);

        // [b02] the machines section — slow pan across the card grid (~19.1s).
        await slowScrollToBottom(page, 14);
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await narrate(page, 'b02 machines section — rest at top', 5);

        // [b03] reading a single card — frame media-server-stage (~26.2s).
        const focusCard = page
          .getByTestId('machine-card')
          .filter({ hasText: 'media-server-stage' });
        await centerInView(page, focusCard);
        await highlight(page, focusCard, 2600);
        await narrate(page, 'b03 card top to bottom', 26);

        // [b04] card view vs list view — toggle to list, then back (~15.3s).
        await clickWithCursor(page, page.getByTestId('view-toggle-list'));
        await expect(page.getByTestId('machine-row').first()).toBeVisible();
        await narrate(page, 'b04 list view', 8);
        // The card-view button is icon-only (LayoutGrid) with its label living
        // in a Radix Tooltip portal — it has no aria-label, so the role+name
        // lookup never resolves until the tooltip opens (and Playwright resolves
        // the locator BEFORE moving the cursor to hover it). Use the established
        // lucide svg-class pattern (see web/e2e/specs/admin/webhooks.spec.ts:148,
        // schedules.spec.ts:92, settings/webhooks-manage.spec.ts:109): target
        // `button:has(svg.lucide-layout-grid)` inside the same toolbar that
        // hosts the view-toggle-list testid (dashboard page.tsx:961–1008).
        const cardToggle = page.locator('button:has(svg.lucide-layout-grid)').first();
        await clickWithCursor(page, cardToggle);
        await expect(page.getByTestId('machine-card').first()).toBeVisible();
        await narrate(page, 'b04 back to cards', 6);

        // [b05] expand/collapse-all + the metrics detail panel (~19.5s).
        // Tooltip-only accessible name like the card-view toggle above — use the
        // same lucide svg-class pattern. Default load state is collapsed → icon
        // is ChevronsUpDown (dashboard page.tsx:970 swaps to ChevronsDownUp once
        // expanded).
        // At page load, processesExpanded defaults to true (AuthContext.tsx:185 +
        // seed.ts:112), so `allExpanded` in dashboard/page.tsx:401 is true and
        // the toggle is in the "collapse all" position. Click it once → rows
        // collapse (which hides the cpu tile we're about to click) → click
        // again → rows re-expand, demonstrating the feature without breaking
        // the rest of the beat.
        const collapseAll = page.locator('button:has(svg.lucide-chevrons-down-up)').first();
        await clickWithCursor(page, collapseAll);
        await page.waitForTimeout(600);
        const expandAll = page.locator('button:has(svg.lucide-chevrons-up-down)').first();
        await clickWithCursor(page, expandAll);
        await page.waitForTimeout(600);
        await narrate(page, 'b05 toggle expand-all', 4);
        // Tap the focus card's cpu tile to slide the detail panel open.
        const focusCardAfter = page
          .getByTestId('machine-card')
          .filter({ hasText: 'media-server-stage' });
        await clickWithCursor(page, focusCardAfter.getByText('cpu', { exact: true }).first());
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await narrate(page, 'b05 detail panel open', 15);

        // [b06] the rest of the app — open the page-selector dropdown (~25.7s).
        // Close the detail panel first so the header sits near the top.
        await page.keyboard.press('Escape'); // VERIFY: MetricsDetailPanel may not close on Escape; fallback is the onClose X button
        await page.waitForTimeout(400);
        const pageSelector = page.getByRole('button', { name: /^dashboard/i }); // VERIFY: the breadcrumb page-selector trigger renders "dashboard" with a chevron; role=button match
        await clickWithCursor(page, pageSelector);
        await narrate(page, 'b06 nav dropdown', 26);
      },
    );
  } finally {
    await ctx.cleanup();
  }
});
