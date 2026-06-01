/**
 * Scene — episode 7, "remote actions: reboot, screenshot, live view".
 *
 * Every beat is a SCREEN beat (no B-ROLL), so all seven are captured here.
 * Rendered VO durations (voiceover/out/07-remote-actions/):
 *   b01 ≈ 12.0s — the actions menu (open the ⋮ menu)
 *   b02 ≈ 15.5s — take a screenshot (ScreenshotDialog history sidebar)
 *   b03 ≈ 16.2s — live view (LiveViewModal interval + start/stop)
 *   b04 ≈ 18.1s — reboot (RestartDialog with 30-second confirm)
 *   b05 ≈ 14.8s — shutdown (ShutdownDialog) + scheduling gear
 *   b06 ≈ 12.9s — mute alerts (the "mute alerts" menu item)
 *   b07 ≈ 46.8s — who can do what (a long pass over the menu calling out perm tiers)
 *
 * Fixture: `dashboard-mixed-states` (script front matter). Same admin storageState
 * as ep01 — the admin role is a site-admin on site-A, so every action in the
 * menu (screenshot / live view / reboot / shutdown / revoke / remove) renders.
 * `media-server-stage` is the canonical card we target — it's online (alerting
 * state, lastHeartbeat 5s ago) so the online-gated items (restart machine /
 * shutdown / screenshot / live view) appear.
 *
 * Selectors:
 *   data-testid="machine-context-menu-trigger"      — the ⋮ button
 *   data-testid="machine-context-menu-reboot"       — "restart machine"
 *   data-testid="machine-context-menu-shutdown"     — "shutdown machine"
 *   data-testid="machine-context-menu-revoke-token" — "revoke token"
 *   data-testid="machine-context-menu-remove"       — "remove machine"
 * (the "screenshot", "live view", and "mute alerts" items don't have testids,
 *  so they're matched by their exact menu text — marked VERIFY.)
 *
 * Run:  cd web && npm run videos -- --grep "episode 7"
 * Out:  web/e2e/.output/videos/07-remote-actions.mp4
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
  moveCursorTo,
} from './video-helpers';

test('episode 7 — remote actions: reboot, screenshot, live view', async ({ browser }) => {
  const ctx = await seedScreenshotFixtures('dashboard-mixed-states');
  try {
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    await recordScene(
      browser,
      '07-remote-actions',
      { baseURL: E2E_BASE_URL, storageState: roleState('admin').storageState },
      async (page) => {
        await openForCapture(page, '/dashboard');
        await expect(page.getByTestId('machine-card')).toHaveCount(10);

        // The canonical target throughout: media-server-stage (online, alerting).
        const focusCard = page
          .getByTestId('machine-card')
          .filter({ hasText: 'media-server-stage' });
        await centerInView(page, focusCard);

        // [b01] the actions menu — click the ⋮ on the focused card; the menu
        // unrolls with restart / shutdown / screenshot / live view / mute /
        // revoke / remove (~12.0s VO).
        //
        // The trigger button is wrapped in a Radix Tooltip ("machine options"
        // — see MachineContextMenu.tsx:173-193). When the cursor hovers via
        // moveCursorTo, the Tooltip portal mounts and overlays the trigger,
        // intercepting the subsequent click and producing a 15s click-
        // timeout. The shared `clickWithCursor` is off-limits, so each
        // trigger-press here uses `moveCursorTo` (to keep the cursor motion
        // on camera) followed by `click({ force: true })` to bypass the
        // tooltip overlay. The tooltip is visually benign — forcing past it
        // is consistent with how the dispatch specs call `.click()` directly
        // with no prior hover.
        const menuTrigger = focusCard.getByTestId('machine-context-menu-trigger');
        await moveCursorTo(page, menuTrigger);
        await page.waitForTimeout(250);
        await menuTrigger.click({ force: true });
        await page.waitForTimeout(600);
        await narrate(page, 'b01 menu opens', 12);

        // [b02] take a screenshot — click "screenshot"; ScreenshotDialog mounts
        // with a history sidebar on the left and download / fullscreen
        // controls on the right. The history sidebar is always rendered with
        // the capture button at its foot, so the dialog's character reads
        // immediately even if no real screenshot has come back yet (~15.5s).
        const screenshotItem = page.getByRole("menuitem", { name: "screenshot" }); // VERIFY: DropdownMenuItem text is exactly "screenshot"
        await clickWithCursor(page, screenshotItem);
        await page.waitForTimeout(900);
        await narrate(page, 'b02 screenshot dialog', 15);

        // Close the screenshot dialog and reopen the actions menu for the
        // next beat. The dialog's X button lives in the title bar. Same
        // tooltip-overlay workaround as b01: force the click past the
        // "machine options" tooltip. Bumped the post-escape wait to 900ms —
        // the dialog's exit animation + focus restoration finishes around
        // 700ms, and a too-early menu reopen lands while the menu DOM is
        // still in a transitional state, leaving the next menuitem lookup
        // to time out.
        await page.keyboard.press('Escape');
        await page.waitForTimeout(900);
        await moveCursorTo(page, menuTrigger);
        await page.waitForTimeout(250);
        await menuTrigger.click({ force: true });
        await page.waitForTimeout(700);

        // [b03] live view — click "live view"; LiveViewModal mounts with the
        // interval selector (5s/10s/20s/30s/60s) and start/stop button at
        // the bottom (~16.2s VO).
        // Drop `exact: true` — the DropdownMenuItem text in
        // components/MachineContextMenu.tsx:296-299 is
        // `<Eye .../>\n              live view`, so the accessible name has
        // leading whitespace that exact-match misses. Partial is enough.
        const liveViewItem = page.getByRole('menuitem', { name: 'live view' });
        await clickWithCursor(page, liveViewItem);
        await page.waitForTimeout(900);
        await narrate(page, 'b03 live view modal', 16);

        // Close live view and reopen the menu for the reboot beat.
        // (Same tooltip-overlay workaround as b01.)
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        await moveCursorTo(page, menuTrigger);
        await page.waitForTimeout(250);
        await menuTrigger.click({ force: true });
        await page.waitForTimeout(500);

        // [b04] reboot — click "restart machine"; the RestartDialog mounts
        // with the 30-second-countdown copy and a cancel button. We don't
        // confirm — just frame the dialog so the safety window reads (~18.1s).
        const rebootItem = focusCard.page().getByTestId('machine-context-menu-reboot');
        await clickWithCursor(page, rebootItem);
        await page.waitForTimeout(700);
        await narrate(page, 'b04 reboot dialog', 18);

        // Cancel the reboot confirmation and reopen the menu.
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        await clickWithCursor(page, menuTrigger);
        await page.waitForTimeout(500);

        // [b05] shutdown — click "shutdown machine"; same 30-second safety
        // copy. After framing the dialog, dismiss and re-open the menu so we
        // can also show the inline "schedule restarts" gear next to the
        // restart row (~14.8s VO total — split half/half between the dialog
        // and the gear).
        const shutdownItem = focusCard.page().getByTestId('machine-context-menu-shutdown');
        await clickWithCursor(page, shutdownItem);
        await page.waitForTimeout(700);
        await narrate(page, 'b05 shutdown dialog', 8);
        // (Same tooltip-overlay workaround as b01.)
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        await moveCursorTo(page, menuTrigger);
        await page.waitForTimeout(250);
        await menuTrigger.click({ force: true });
        await page.waitForTimeout(500);
        // The schedule gear is a small Settings2 button inside the same row
        // as the "restart machine" item (tooltip "schedule restarts"). It
        // doesn't have a testid, so we target by its aria/tooltip text.
        const scheduleGear = page.getByRole('button', { name: 'schedule restarts' }); // VERIFY: tooltip text "schedule restarts" — the button itself has no aria-label, so this depends on TooltipTrigger surfacing the tooltip content as the accessible name
        await centerInView(page, scheduleGear);
        await highlight(page, scheduleGear, 2400);
        await narrate(page, 'b05 schedule gear', 7);

        // [b06] mute alerts — same open menu. Highlight the "mute alerts"
        // item (it's never gated by online state or role — every team
        // member sees it) (~12.9s VO).
        const muteItem = page.getByRole("menuitem", { name: "mute alerts" }); // VERIFY: DropdownMenuItem renders "mute alerts" when isMuted=false (default for the seed)
        await centerInView(page, muteItem);
        await highlight(page, muteItem, 2600);
        await narrate(page, 'b06 mute alerts', 13);

        // [b07] who can do what — a long pass over the menu calling out
        // each permission tier. Total ~46.8s VO. We walk through groups:
        //   member-or-above:    screenshot, live view  (~12s)
        //   site-admin:         restart, shutdown, remove machine  (~14s)
        //   superadmin-only:    revoke token  (~10s)
        //   everyone:           mute alerts  (~11s)
        await highlight(page, screenshotItem, 2400);
        await highlight(page, liveViewItem, 2400);
        await narrate(page, 'b07 perms — member', 12);
        await highlight(page, rebootItem, 2400);
        await highlight(page, shutdownItem, 2400);
        const removeItem = focusCard.page().getByTestId('machine-context-menu-remove');
        await highlight(page, removeItem, 2400);
        await narrate(page, 'b07 perms — site admin', 14);
        const revokeItem = focusCard.page().getByTestId('machine-context-menu-revoke-token');
        await highlight(page, revokeItem, 2600);
        await narrate(page, 'b07 perms — superadmin', 10);
        await highlight(page, muteItem, 2600);
        await narrate(page, 'b07 perms — everyone', 11);
      },
    );
  } finally {
    await ctx.cleanup();
  }
});
