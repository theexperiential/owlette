/**
 * Scene — episode 4, "keep a process alive".
 *
 * Every beat in this episode is a SCREEN beat (web capture). No B-ROLL to skip.
 * Beats and their rendered VO durations (voiceover/out/04-keep-a-process-alive/):
 *   b01 ≈ 13.9s — the promise (frame the td-control-room card)
 *   b02 ≈  9.1s — add a process (open the dialog)
 *   b03 ≈ 19.8s — the essential fields (name + launch mode + exe path + file path)
 *   b04 ≈ 23.8s — the resilience knobs (priority / visibility / delay / init / attempts)
 *   b05 ≈ 12.0s — save and watch it run (create process, see status)
 *   b06 ≈ 26.3s — what happens on a crash (LAUNCHING touchdesigner + reboot pending banner)
 *   b07 ≈ 19.6s — day-to-day controls (hover the row, point at toggles/restart/kill/edit)
 *
 * Reuses the screenshots harness verbatim: the `control-process-restarting`
 * fixture (4 machines, td-control-room as the focus with a pre-seeded
 * touchdesigner.exe in LAUNCHING) + the admin role storageState.
 *
 * Pre-record state hacks (same pattern as ep01's `lastSiteId` set):
 *   1. Auto-select the seeded site on load.
 *   2. Set `rebootPending.active = true` on td-control-room so the amber
 *      "restart pending" banner is visible in b06. (The fixture intentionally
 *      doesn't set this because the static screenshot specs frame other states.)
 *
 * Run:  cd web && npm run videos -- --grep "episode 4"
 * Out:  web/e2e/.output/videos/04-keep-a-process-alive.mp4
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
  typewrite,
} from './video-helpers';

test('episode 4 — keep a process alive', async ({ browser }) => {
  const ctx = await seedScreenshotFixtures('control-process-restarting');
  try {
    // Auto-select the seeded site on load.
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    await recordScene(
      browser,
      '04-keep-a-process-alive',
      { baseURL: E2E_BASE_URL, storageState: roleState('admin').storageState },
      async (page) => {
        await openForCapture(page, '/dashboard');

        // [b01] the promise — frame the td-control-room card (~13.9s).
        const focusCard = page
          .getByTestId('machine-card')
          .filter({ hasText: 'td-control-room' });
        await expect(focusCard).toBeVisible();
        await centerInView(page, focusCard);
        await highlight(page, focusCard, 2600);
        await narrate(page, 'b01 the promise', 14);

        // [b02] add a process — click "+ add process" on the focus card (~9.1s).
        // The card renders an "add process" button at the bottom (text-based,
        // no testid; sits inside the focus card).
        const addProcessButton = focusCard.getByRole('button', { name: /add process/i }); // VERIFY: button has tooltip-free text "add process"; first match should be inside the focus card
        await clickWithCursor(page, addProcessButton);
        // Dialog opens — title "add process".
        await expect(page.getByRole('dialog')).toBeVisible();
        await narrate(page, 'b02 open dialog', 9);

        // [b03] the essential fields — fill name / launch mode / exe / file path (~19.8s).
        await typewrite(page, page.locator('#edit-name'), 'TouchDesigner', 65);
        // Launch mode segmented control — click "Always On".
        const alwaysOnPill = page.getByRole('button', { name: 'Always On' }); // VERIFY: segmented control renders a <button> with literal text "Always On"
        await clickWithCursor(page, alwaysOnPill);
        await typewrite(
          page,
          page.locator('#edit-exe-path'),
          'C:\\Program Files\\Derivative\\TouchDesigner\\bin\\TouchDesigner.exe',
          25,
        );
        await typewrite(
          page,
          page.locator('#edit-file-path'),
          'C:\\Owlette\\projects\\stage-show\\main.toe',
          25,
        );
        await narrate(page, 'b03 essential fields', 20);

        // [b04] the resilience knobs — highlight the rarely-changed dials (~23.8s).
        await centerInView(page, page.locator('#edit-cwd'));
        await highlight(page, page.locator('#edit-priority'), 1600);
        await highlight(page, page.locator('#edit-visibility'), 1600);
        await highlight(page, page.locator('#edit-time-delay'), 1600);
        await highlight(page, page.locator('#edit-time-init'), 1600);
        await highlight(page, page.locator('#edit-relaunch'), 1600);
        await narrate(page, 'b04 resilience knobs', 24);

        // [b05] save and watch it run — click "create process" (~12.0s).
        const createButton = page.getByRole('button', { name: 'create process' }); // VERIFY: dialog footer button
        await clickWithCursor(page, createButton);
        await expect(page.getByRole('dialog')).not.toBeVisible();
        // Toast appears with success copy; new row should render on the focus card.
        await narrate(page, 'b05 save and watch', 12);

        // [b06] what happens on a crash — pre-seed rebootPending so the amber
        // banner shows on the focus card, then frame it (~26.3s).
        await getAdminDb()
          .collection('sites')
          .doc(ctx.siteId)
          .collection('machines')
          .doc(ctx.machineId!)
          .set(
            {
              rebootPending: {
                active: true,
                processName: 'touchdesigner.exe',
                reason: 'process crashed repeatedly',
                timestamp: Math.floor(Date.now() / 1000),
              },
            },
            { merge: true },
          );
        // Give Firestore listener a tick to repaint the banner.
        await page.waitForTimeout(800);
        const focusCardAfter = page
          .getByTestId('machine-card')
          .filter({ hasText: 'td-control-room' });
        await centerInView(page, focusCardAfter);
        await highlight(page, focusCardAfter, 2200);
        // Banner has approve / dismiss buttons (testids exist).
        const approveButton = focusCardAfter.getByTestId('reboot-pending-approve');
        const dismissButton = focusCardAfter.getByTestId('reboot-pending-dismiss');
        await highlight(page, approveButton, 1600);
        await highlight(page, dismissButton, 1600);
        await narrate(page, 'b06 crash + banner', 26);

        // [b07] day-to-day controls — point at the inline toggle / restart / kill / edit (~19.6s).
        // The toolbar lives inside the process list of the focus card. The fixture
        // pre-seeded touchdesigner.exe in LAUNCHING (responsive=false), so its
        // restart/kill remain enabled. We outline each control in sequence.
        const focusCardFinal = page
          .getByTestId('machine-card')
          .filter({ hasText: 'td-control-room' });
        // Hover the touchdesigner.exe row to surface controls.
        // After b05 the focus card has TWO process rows — the seeded
        // touchdesigner.exe AND the newly-created "TouchDesigner" — so
        // `.locator('div').filter(...).first()` resolves to the outer
        // rounded process-list container (MachineCardView.tsx:762), which
        // wraps both rows. Inside that container the "Always On" /
        // "Scheduled" segmented-control buttons appear twice (one per row).
        // `.first()` at the end of each button locator picks the seeded
        // touchdesigner.exe row's controls (first in DOM order — the seeded
        // process is at index 0, see fixtures.ts).
        // The restart/kill buttons get their accessible name from
        // `aria-label={\`restart ${process.name}\`}` (MachineCardView.tsx:839,
        // 856), so `restart touchdesigner.exe` is already unique to the
        // seeded row (the new row's labels read "restart TouchDesigner").
        const tdRow = focusCardFinal
          .locator('div')
          .filter({ hasText: /^touchdesigner\.exe/ })
          .first();
        await centerInView(page, tdRow);
        // The Off / Always On / Scheduled inline toggle group (3 buttons in a row).
        await highlight(page, tdRow.getByRole('button', { name: /^Always On$/ }).first(), 1500);
        await highlight(page, tdRow.getByRole('button', { name: /^Scheduled$/ }).first(), 1500);
        // Restart / kill / edit buttons live in the same row — use aria-label patterns
        // set on the row (restart ${name}, kill ${name}).
        await highlight(page, tdRow.getByRole('button', { name: /^restart touchdesigner\.exe$/ }), 1500);
        await highlight(page, tdRow.getByRole('button', { name: /^kill touchdesigner\.exe$/ }), 1500);
        // The pencil/edit button has no aria-label — fall back to icon-button neighbor.
        // It sits between Scheduled and restart in the action group.
        await narrate(page, 'b07 day-to-day controls', 20);
      },
    );
  } finally {
    await ctx.cleanup();
  }
});
