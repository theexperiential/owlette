/**
 * Scene — episode 4, "keep a process alive". All SCREEN beats, no B-ROLL.
 * VO durations (voiceover/out/04-keep-a-process-alive/):
 *   b01 13.9s the promise · b02 9.1s add a process · b03 19.8s essential fields
 *   b04 23.8s resilience knobs · b05 12.0s save and watch · b06 26.3s crash
 *   b07 19.6s day-to-day controls
 *
 * Uses the screenshots harness verbatim: `control-process-restarting` fixture
 * (td-control-room focused, touchdesigner.exe pre-seeded in LAUNCHING) + the
 * admin storageState. Pre-record hacks: auto-select the seeded site, and set
 * `rebootPending.active` for b06's amber banner (the fixture leaves it off
 * because the static screenshot specs frame other states).
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

        // [b02] add a process — the focus card's bottom button (no testid).
        const addProcessButton = focusCard.getByRole('button', { name: /add process/i }); // VERIFY: button has tooltip-free text "add process"; first match should be inside the focus card
        await clickWithCursor(page, addProcessButton);
        await expect(page.getByRole('dialog')).toBeVisible();
        await narrate(page, 'b02 open dialog', 9);

        // [b03] essential fields — name / launch mode / exe / file path.
        await typewrite(page, page.locator('#edit-name'), 'TouchDesigner', 65);
        const alwaysOnPill = page.getByRole('button', { name: 'always on' }); // VERIFY: segmented control renders a <button> with literal text "always on"
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

        // [b04] resilience knobs.
        await centerInView(page, page.locator('#edit-cwd'));
        await highlight(page, page.locator('#edit-priority'), 1600);
        await highlight(page, page.locator('#edit-visibility'), 1600);
        await highlight(page, page.locator('#edit-time-delay'), 1600);
        await highlight(page, page.locator('#edit-time-init'), 1600);
        await highlight(page, page.locator('#edit-relaunch'), 1600);
        await narrate(page, 'b04 resilience knobs', 24);

        // [b05] save and watch it run.
        const createButton = page.getByRole('button', { name: 'create process' }); // VERIFY: dialog footer button
        await clickWithCursor(page, createButton);
        await expect(page.getByRole('dialog')).not.toBeVisible();
        await narrate(page, 'b05 save and watch', 12);

        // [b06] crash — pre-seed rebootPending so the amber banner shows.
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
        // Let the Firestore listener repaint the banner.
        await page.waitForTimeout(800);
        const focusCardAfter = page
          .getByTestId('machine-card')
          .filter({ hasText: 'td-control-room' });
        await centerInView(page, focusCardAfter);
        await highlight(page, focusCardAfter, 2200);
        const approveButton = focusCardAfter.getByTestId('reboot-pending-approve');
        const dismissButton = focusCardAfter.getByTestId('reboot-pending-dismiss');
        await highlight(page, approveButton, 1600);
        await highlight(page, dismissButton, 1600);
        await narrate(page, 'b06 crash + banner', 26);

        // [b07] day-to-day controls — inline toggle / restart / kill / edit. The
        // seeded touchdesigner.exe is LAUNCHING (responsive=false), so its
        // restart/kill stay enabled.
        const focusCardFinal = page
          .getByTestId('machine-card')
          .filter({ hasText: 'td-control-room' });
        // After b05 the card holds TWO process rows, so this `.first()` resolves
        // to the process-list container wrapping both, and the segmented-control
        // buttons appear twice inside it — the trailing `.first()` on each button
        // picks the seeded touchdesigner.exe row (index 0, see fixtures.ts).
        // restart/kill are already unique: their aria-labels carry the process
        // name, and the new row reads "restart TouchDesigner".
        const tdRow = focusCardFinal
          .locator('div')
          .filter({ hasText: /^touchdesigner\.exe/ })
          .first();
        await centerInView(page, tdRow);
        await highlight(page, tdRow.getByRole('button', { name: /^always on$/ }).first(), 1500);
        await highlight(page, tdRow.getByRole('button', { name: /^scheduled$/ }).first(), 1500);
        await highlight(page, tdRow.getByRole('button', { name: /^restart touchdesigner\.exe$/ }), 1500);
        await highlight(page, tdRow.getByRole('button', { name: /^kill touchdesigner\.exe$/ }), 1500);
        // TODO: the pencil/edit button has no aria-label — nothing to target yet.
        await narrate(page, 'b07 day-to-day controls', 20);
      },
    );
  } finally {
    await ctx.cleanup();
  }
});
