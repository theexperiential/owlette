/**
 * Scene — episode 4, "the dashboard, end to end". All SCREEN beats, no B-ROLL.
 *
 * Rendered VO (voiceover/out/04-dashboard-tour/, ffprobe, 2026-08-31 evening
 * re-voice — the collapsed-open b02 rewrite):
 *   b01 22.5s orientation (switcher DEMONSTRATED) · b02 20.7s machines, folded
 *   b03 27.7s reading a single card (staged reveals) · b04 19.0s card vs list
 *   b05 18.6s expand, collapse, detail panel · b06 24.8s the rest of the app
 *
 * EVERY in-beat action below is cued to the narration's measured phrase
 * timings (voiceover/measure-phrases.py against the beat MP3s), not eyeballed
 * dwells — the previous take toggled list view while cards were still being
 * praised and crawled the b06 hover behind the spoken list. If the VO is ever
 * re-rendered, re-measure and re-cue; do not reuse these numbers.
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
  slowPush,
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

        // PRE-ROLL (off camera): fold every card. The episode OPENS rolled up
        // — rosco's note after the take that still showed expanded cards — and
        // b03 does all the revealing. State can arrive mixed, so take whichever
        // direction the toggle shows.
        const collapseAllPre = page.locator('button:has(svg.lucide-chevrons-down-up)');
        if (await collapseAllPre.count()) {
          await clickWithCursor(page, collapseAllPre.first());
        }
        await page.waitForTimeout(500);

        // [b01] orientation (~22.5s). The site switcher is DEMONSTRATED, not
        // pointed at: click it open exactly on "click it" (measured 4.7s), hold
        // the dropdown through the sentence's pause (to ~10.0s), Escape closed,
        // then the two stat tiles (measured 10.9s and 16.0s).
        const siteSwitcher = page.getByTestId('site-switcher-trigger');
        await highlight(page, siteSwitcher, 1800);
        await narrate(page, 'b01 this is home — the breadcrumb', 3.9);
        await clickWithCursor(page, siteSwitcher);            // opens @4.7
        await narrate(page, 'b01 switcher open — hop between sites', 4.5);
        await page.keyboard.press('Escape');                  // closed @~10.0
        // Stat labels carry no testid; the lowercase caption under each number
        // is the only handle. `online` also appears on machine pills, so the
        // first match is the tile — which is what renders above the grid.
        const onlineTile = page.getByText('online', { exact: true }).first();
        await highlight(page, onlineTile, 1600);
        await narrate(page, 'b01 online tile', 2.4);
        const processesTile = page.getByText('processes', { exact: true }).first();
        await highlight(page, processesTile, 1600);
        await narrate(page, 'b01 processes tile', 0.5);
        // Push toward the header stats MID-beat and resolve the move inside
        // the beat. RULE (learned when this push sat at the beat's tail and
        // read as a glitch): a move starts by ~60% of the beat and its
        // ease-back completes >=1s before the beat ends. slowPush BLOCKS, so
        // it spends beat time exactly like a narrate dwell — charge clicks
        // (~0.7s) and highlights (their ms) against the budget too.
        await slowPush(page, { scale: 1.035, originXPct: 50, originYPct: 12, seconds: 3.2 });
        await slowPush(page, { scale: 1.0, seconds: 2.4 });
        await narrate(page, 'b01 whole operation in one glance', 0.3);

        // [b02] the machines section (~20.7s) — the COLLAPSED grid, rewritten
        // light: the folded cards fit in ~1.2 viewports, so a short gentle
        // drift replaces the long pan that read "too heavy... scrolls weird".
        // The beat clock starts at the first narrate, so open it before the
        // drift. Rest at the bottom; the jump back up is in the trimmed tail.
        await narrate(page, 'b02 machines — folded grid, drift begins', 0.4);
        await slowScrollToBottom(page, 6);
        await narrate(page, 'b02 machines — rest', 0.6);
        await slowPush(page, { scale: 1.05, originXPct: 50, originYPct: 60, seconds: 3.0 });
        await narrate(page, 'b02 vitals at a glance', 3.2);
        await slowPush(page, { scale: 1.0, seconds: 2.5 });
        await narrate(page, 'b02 without touching a thing', 0.5);
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));

        // b02's TRIMMED TAIL: cards are already folded (pre-roll); just seat
        // the focus card for b03's staged reveal.
        const focusCard = page
          .getByTestId('machine-card')
          .filter({ hasText: 'media-server-stage' });
        await centerInView(page, focusCard);

        // [b03] reading a single card — STAGED reveals (~25.4s). Measured
        // cues: metrics spoken at 6.1s, displays 14.6s, processes 16.7s,
        // "each section folds away" 20.1s. Each collapsed section renders a
        // chevron-down trigger button, in render order stats → displays →
        // processes, and an expanded section's trigger unmounts — so clicking
        // the card's FIRST chevron-down walks the sections in order. The
        // trigger buttons are full-width; the `.w-full` filter matters because
        // a shadcn Select trigger on the card ALSO carries a chevron-down (it
        // is `w-fit`, role=combobox) and clicking it opens a dropdown whose
        // portal intercepts every later click — which killed a take.
        const nextFold = () =>
          focusCard.locator('button.w-full:has(svg.lucide-chevron-down)').first();
        // The section state is SHARED across cards (the same preference the
        // expand/collapse-all control drives), so every card reveals in sync —
        // that is how the UI works, not a spec bug. Keep the focus card
        // dominant with a re-center after the expansions reflow the grid.
        await highlight(page, focusCard, 2000);
        await narrate(page, 'b03 pill + heartbeat, card folded', 2.4);
        await slowPush(page, { scale: 1.04, originXPct: 50, originYPct: 45, seconds: 2.6 });
        await clickWithCursor(page, nextFold());              // metrics @6.6
        await centerInView(page, focusCard);
        await narrate(page, 'b03 metrics revealed', 1.0);
        await slowPush(page, { scale: 1.07, originXPct: 50, originYPct: 45, seconds: 4.0 });
        await narrate(page, 'b03 metrics — sparklines and temps', 3.9);
        await clickWithCursor(page, nextFold());              // displays @15.3
        await narrate(page, 'b03 displays revealed', 1.6);
        await clickWithCursor(page, nextFold());              // processes @17.0
        await centerInView(page, focusCard);
        await slowPush(page, { scale: 1.08, originXPct: 50, originYPct: 50, seconds: 3 });
        await narrate(page, 'b03 processes revealed', 3.6);
        // "each section folds away" — fold displays back up on the line. The
        // expanded stats and displays sections each show a chevron-up trigger;
        // nth(1) is displays.
        await clickWithCursor(page, focusCard.locator('svg.lucide-chevron-up').nth(1));
        await slowPush(page, { scale: 1.0, seconds: 4.0 });
        await narrate(page, 'b03 folds away when not needed', 2.2);

        // [b04] card view vs list view (~18.2s). Measured cues: "flip to list
        // view" 7.2s, rolled-up rows praised to 11.8s, "any row expands" 11.8s,
        // "one click back to cards" 15.4s. The row click lands on the hostname
        // cell — metric cells stopPropagation and would open the detail panel.
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await narrate(page, 'b04 cards praised first', 7.2);
        await clickWithCursor(page, page.getByTestId('view-toggle-list'));  // @7.2
        await expect(page.getByTestId('machine-row').first()).toBeVisible();
        await narrate(page, 'b04 list appears', 1.0);
        // The rows arrive carrying whatever per-row panel state b03 left, so
        // ROLL THEM ALL UP exactly on "rolls up into one scannable row"
        // (spoken 9.3s) — the fold happens as the words land. The toggle's
        // icon depends on the state b03 left, so take whichever direction is
        // showing (expand-all first just flips it to collapse-all).
        const collapseAllBtn = page.locator('button:has(svg.lucide-chevrons-down-up)');
        if (await collapseAllBtn.count()) {
          await clickWithCursor(page, collapseAllBtn.first());              // @9.2
        } else {
          await clickWithCursor(
            page, page.locator('button:has(svg.lucide-chevrons-up-down)').first());
          await clickWithCursor(page, collapseAllBtn.first());
        }
        await narrate(page, 'b04 rows rolled up', 1.9);
        const focusRow = page
          .getByTestId('machine-row')
          .filter({ hasText: 'media-server-stage' });
        await clickWithCursor(page, focusRow.getByText('media-server-stage')); // @11.8
        await narrate(page, 'b04 row expanded in place', 3.2);
        // Icon-only button whose label lives in a Radix Tooltip portal: no
        // aria-label, and role+name can't resolve before the cursor hovers. Use
        // the repo's lucide svg-class pattern instead (cf. admin/webhooks.spec.ts).
        const cardToggle = page.locator('button:has(svg.lucide-layout-grid)').first();
        await clickWithCursor(page, cardToggle);              // @15.4
        await expect(page.getByTestId('machine-card').first()).toBeVisible();
        await narrate(page, 'b04 back on cards', 2.0);

        // [b05] expand/collapse-all + the metrics detail panel (~18.1s). The
        // b02-tail collapse left the control in "expand all" state (see above):
        // demo expand-all, then collapse-all, then expand-all again so the cpu
        // tile exists for the panel click. The locator re-resolves every click
        // because the icon (and so the class) alternates.
        await clickWithCursor(
          page, page.locator('button:has(svg.lucide-chevrons-up-down)').first());
        await narrate(page, 'b05 expand all', 2.2);
        await clickWithCursor(
          page, page.locator('button:has(svg.lucide-chevrons-down-up)').first());
        await narrate(page, 'b05 collapse all', 1.8);
        await clickWithCursor(
          page, page.locator('button:has(svg.lucide-chevrons-up-down)').first());
        await narrate(page, 'b05 expand all again', 1.6);
        // Tap the focus card's cpu tile to slide the detail panel open.
        const focusCardAfter = page
          .getByTestId('machine-card')
          .filter({ hasText: 'media-server-stage' });
        await centerInView(page, focusCardAfter);
        await clickWithCursor(page, focusCardAfter.getByText('cpu', { exact: true }).first());
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await narrate(page, 'b05 detail panel open', 2.0);
        // Scrub the history chart while the panel is discussed — the hover
        // tooltip tracks the cursor, so the hold shows live data instead of a
        // frozen frame. The panel sits at the top after the scroll; sweep
        // across its plot line slowly.
        {
          const closeBox = await page.getByTestId('metrics-detail-close-button').boundingBox();
          const scrubY = (closeBox?.y ?? 120) + 220;
          await page.mouse.move(420, scrubY);
          for (let i = 0; i <= 40; i++) {
            await page.mouse.move(420 + ((1460 - 420) * i) / 40, scrubY);
            await page.waitForTimeout(110);
          }
        }
        await narrate(page, 'b05 panel — full history charted', 2.4);

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
        //
        // [b06] ~23.0s, and the hover MOVES AT THE SPOKEN CADENCE — the names
        // land at measured 5.0 / 7.4 / 9.8 / 12.4 / 14.9s (~2.4s apart), where
        // the old take gave each 5.4s and finished a lifetime after the VO.
        const pageSelector = page.getByRole('button', { name: /^dashboard$/i });
        await narrate(page, 'b06 and that is just the dashboard', 2.0);
        await clickWithCursor(page, pageSelector);            // opens @2.3
        await narrate(page, 'b06 switcher open — five more pages', 2.2);
        const navItems = ['hoot', 'talons', 'roost', 'deploy', 'logs'];
        for (const name of navItems) {
          const item = page.getByRole('menuitem').filter({ hasText: new RegExp(`^${name}`) }).first();
          await highlight(page, item, 1200);                  // ~2.4s per name
          await narrate(page, `b06 nav — ${name}`, 1.3);
        }
        // Close the menu for the hand-off; Radix menus do answer Escape.
        await page.keyboard.press('Escape');
        await narrate(page, 'b06 hand-off to episode 5', 7.2);
      },
    );
  } finally {
    await ctx.cleanup();
  }
});
