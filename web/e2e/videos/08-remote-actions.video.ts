/**
 * Scene — episode 7, "remote actions: reboot, screenshot, live view".
 * All seven beats are SCREEN beats. Rendered VO lengths
 * (voiceover/out/08-remote-actions/):
 *   b01 12.0s actions menu | b02 15.5s screenshot | b03 16.2s live view
 *   b04 18.1s reboot | b05 14.8s shutdown + schedule gear | b06 12.9s mute
 *   b07 46.8s permission tiers
 *
 * Fixture `dashboard-mixed-states`, admin storageState (site-admin on site-A so
 * every menu item renders). Target card `media-server-stage` is online, which
 * is what gates screenshot / live view / restart / shutdown.
 *
 * Testids: machine-context-menu-{trigger,reboot,shutdown,revoke-token,remove}.
 * screenshot / live view / mute alerts have no testid — matched by menu text
 * (marked VERIFY below).
 *
 * Run:  cd web && npm run videos -- --grep "episode 7"
 * Out:  web/e2e/.output/videos/08-remote-actions.mp4
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
      '08-remote-actions',
      { baseURL: E2E_BASE_URL, storageState: roleState('admin').storageState },
      async (page) => {
        await openForCapture(page, '/dashboard');
        await expect(page.getByTestId('machine-card')).toHaveCount(10);

        // The canonical target throughout: media-server-stage (online, alerting).
        const focusCard = page
          .getByTestId('machine-card')
          .filter({ hasText: 'media-server-stage' });
        await centerInView(page, focusCard);

        // [b01] the actions menu (~12.0s VO).
        //
        // The ⋮ trigger sits inside a Radix Tooltip (MachineContextMenu.tsx:173-193):
        // hovering mounts the tooltip portal over the trigger and the follow-up
        // click times out after 15s. So every trigger press here is
        // moveCursorTo (keeps cursor motion on camera) + click({ force: true })
        // rather than clickWithCursor.
        const menuTrigger = focusCard.getByTestId('machine-context-menu-trigger');
        await moveCursorTo(page, menuTrigger);
        await page.waitForTimeout(250);
        await menuTrigger.click({ force: true });
        await page.waitForTimeout(600);
        await narrate(page, 'b01 menu opens', 12);

        // [b02] screenshot — ScreenshotDialog mounts with history sidebar and
        // download/fullscreen controls. The sidebar renders even before a real
        // capture returns, so the dialog reads immediately (~15.5s).
        const screenshotItem = page.getByRole("menuitem", { name: "screenshot" }); // VERIFY: DropdownMenuItem text is exactly "screenshot"
        await clickWithCursor(page, screenshotItem);
        await page.waitForTimeout(900);
        await narrate(page, 'b02 screenshot dialog', 15);

        // Close and reopen the menu. Same forced click as b01. 900ms wait: the
        // dialog's exit animation + focus restore ends ~700ms, and reopening
        // earlier leaves the menu DOM transitional and the next lookup times out.
        await page.keyboard.press('Escape');
        await page.waitForTimeout(900);
        await moveCursorTo(page, menuTrigger);
        await page.waitForTimeout(250);
        await menuTrigger.click({ force: true });
        await page.waitForTimeout(700);

        // [b03] live view — LiveViewModal with interval selector and start/stop
        // (~16.2s). No `exact: true`: MachineContextMenu.tsx:296-299 renders
        // `<Eye/>\n live view`, so the accessible name carries leading whitespace.
        const liveViewItem = page.getByRole('menuitem', { name: 'live view' });
        await clickWithCursor(page, liveViewItem);
        await page.waitForTimeout(900);
        await narrate(page, 'b03 live view modal', 16);

        // Close live view, reopen the menu (forced click as in b01).
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        await moveCursorTo(page, menuTrigger);
        await page.waitForTimeout(250);
        await menuTrigger.click({ force: true });
        await page.waitForTimeout(500);

        // [b04] reboot — RestartDialog with the 30s countdown copy. Not
        // confirmed; we only frame the safety window (~18.1s).
        const rebootItem = focusCard.page().getByTestId('machine-context-menu-reboot');
        await clickWithCursor(page, rebootItem);
        await page.waitForTimeout(700);
        await narrate(page, 'b04 reboot dialog', 18);

        // Cancel the reboot confirmation and reopen the menu.
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        await clickWithCursor(page, menuTrigger);
        await page.waitForTimeout(500);

        // [b05] shutdown — same 30s safety copy, then reopen the menu to show
        // the inline "schedule restarts" gear (~14.8s, split half/half).
        const shutdownItem = focusCard.page().getByTestId('machine-context-menu-shutdown');
        await clickWithCursor(page, shutdownItem);
        await page.waitForTimeout(700);
        await narrate(page, 'b05 shutdown dialog', 8);
        // Forced click as in b01.
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        await moveCursorTo(page, menuTrigger);
        await page.waitForTimeout(250);
        await menuTrigger.click({ force: true });
        await page.waitForTimeout(500);
        // Settings2 button in the "restart machine" row; no testid, so matched
        // by its tooltip text.
        const scheduleGear = page.getByRole('button', { name: 'schedule restarts' }); // VERIFY: tooltip text "schedule restarts" — the button itself has no aria-label, so this depends on TooltipTrigger surfacing the tooltip content as the accessible name
        await centerInView(page, scheduleGear);
        await highlight(page, scheduleGear, 2400);
        await narrate(page, 'b05 schedule gear', 7);

        // [b06] mute alerts — never gated by online state or role (~12.9s).
        const muteItem = page.getByRole("menuitem", { name: "mute alerts" }); // VERIFY: DropdownMenuItem renders "mute alerts" when isMuted=false (default for the seed)
        await centerInView(page, muteItem);
        await highlight(page, muteItem, 2600);
        await narrate(page, 'b06 mute alerts', 13);

        // [b07] permission tiers, ~46.8s total:
        //   member+:     screenshot, live view                    (~12s)
        //   site-admin:  restart, shutdown, remove machine        (~14s)
        //   superadmin:  revoke token                             (~10s)
        //   everyone:    mute alerts                              (~11s)
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
