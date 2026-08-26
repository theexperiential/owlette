/**
 * Scene — episode 5, "keep a process alive". All SCREEN beats, no B-ROLL.
 *
 * Rendered VO (voiceover/out/05-keep-a-process-alive/, ffprobe):
 *   b01 13.9s the promise · b02 9.1s add a process · b03 19.8s essential fields
 *   b04 23.8s resilience knobs · b05 12.0s save and watch · b06 28.0s a crash
 *   b07 19.6s day-to-day controls
 *
 * Uses the screenshots harness verbatim: `control-process-restarting`
 * (td-control-room focused, touchdesigner.exe pre-seeded LAUNCHING) + the admin
 * storageState. Two pre-record writes the fixture deliberately leaves out
 * because the still specs frame other states: `rebootPending.active` for b06's
 * amber banner, and b05's agent-written status row (below).
 *
 * Run:  cd web && npm run videos -- --grep "episode 5"
 * Out:  web/e2e/.output/videos/05-keep-a-process-alive.mp4
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { getAdminDb, E2E_BASE_URL } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import { seedScreenshotFixtures, FIXED_NOW_MS } from '../screenshots/fixtures';
import {
  recordScene,
  openForCapture,
  narrate,
  highlight,
  centerInView,
  clickWithCursor,
  typewrite,
} from './video-helpers';

const FIXED_NOW_SEC = Math.floor(FIXED_NOW_MS / 1000);

/** The row b05 brings to life. Ours, not the server's — see the beat comment. */
const NEW_PROCESS_ID = 'proc-td-capture-demo';

test('episode 5 — keep a process alive', async ({ browser }) => {
  const ctx = await seedScreenshotFixtures('control-process-restarting');
  try {
    const db = getAdminDb();
    // Auto-select the seeded site on load.
    await db
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    const machineRef = db
      .collection('sites')
      .doc(ctx.siteId)
      .collection('machines')
      .doc(ctx.machineId!);

    await recordScene(
      browser,
      '05-keep-a-process-alive',
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
        await narrate(page, 'b01 the promise', 15);

        // [b02] add a process — the focus card's "add process" control (~9.1s).
        const addProcessButton = focusCard.getByRole('button', { name: /add process/i });
        await clickWithCursor(page, addProcessButton);
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await narrate(page, 'b02 open dialog', 10);

        // [b03] the essential fields — name / launch mode / exe / file path
        // (~19.8s). Create mode defaults launch mode to "off"
        // (dashboard/page.tsx:558), so setting it really is required; save only
        // validates name + executable path, which is what makes "that's
        // genuinely all you need" true. Every control is scoped to the dialog —
        // the card rows behind it render their own "always on" segments.
        await typewrite(page, dialog.locator('#edit-name'), 'TouchDesigner', 60);
        await clickWithCursor(page, dialog.getByRole('button', { name: 'always on' }));
        await typewrite(
          page,
          dialog.locator('#edit-exe-path'),
          'C:\\Program Files\\Derivative\\TouchDesigner\\bin\\TouchDesigner.exe',
          22,
        );
        await typewrite(
          page,
          dialog.locator('#edit-file-path'),
          'C:\\Owlette\\projects\\stage-show\\main.toe',
          22,
        );
        // 16s, not 7: `typewrite` blocks for text.length × perCharMs, which only
        // buys ~4.4s here (13 + 63 + 39 chars). The beat's MP3 is 19.8s.
        await narrate(page, 'b03 essential fields', 16);

        // [b04] the resilience knobs (~23.8s). relaunch attempts holds longest:
        // it defaults to 3 and 0 is a real setting meaning unlimited
        // (owlette_service.py:2548-2579), which b06 says out loud.
        await centerInView(page, dialog.locator('#edit-cwd'));
        await highlight(page, dialog.locator('#edit-priority'), 1600);
        await narrate(page, 'b04 priority', 4);
        await highlight(page, dialog.locator('#edit-visibility'), 1600);
        await narrate(page, 'b04 visibility', 4);
        await highlight(page, dialog.locator('#edit-time-delay'), 1600);
        await narrate(page, 'b04 launch delay', 4);
        await highlight(page, dialog.locator('#edit-time-init'), 1600);
        await narrate(page, 'b04 init timeout', 5);
        await highlight(page, dialog.locator('#edit-relaunch'), 2400);
        await narrate(page, 'b04 relaunch attempts', 8);

        // [b05] save and watch it run (~12.0s).
        //
        // Create writes only the CONFIG doc (useFirestore.ts:1433 →
        // createProcess.server.ts) while the card's rows render from the
        // agent-written status map (`metrics.processes`, useFirestore.ts:1012).
        // With no agent in the emulator no row would ever appear, so the scene
        // plays the agent: write the row LAUNCHING, hold, then flip it RUNNING.
        // The id is ours rather than the server's — nothing on screen reads it,
        // and reading back the generated one would race the dialog close.
        await clickWithCursor(page, dialog.getByRole('button', { name: 'create process' }));
        await expect(dialog).not.toBeVisible();

        await machineRef.set(
          {
            metrics: {
              processes: {
                [NEW_PROCESS_ID]: {
                  name: 'TouchDesigner',
                  status: 'LAUNCHING',
                  pid: 8140,
                  autolaunch: true,
                  launch_mode: 'always',
                  exe_path:
                    'C:\\Program Files\\Derivative\\TouchDesigner\\bin\\TouchDesigner.exe',
                  file_path: 'C:\\Owlette\\projects\\stage-show\\main.toe',
                  cwd: 'C:\\Program Files\\Derivative\\TouchDesigner\\bin',
                  priority: 'Normal',
                  visibility: 'Show',
                  time_delay: '0',
                  time_to_init: '5',
                  relaunch_attempts: '3',
                  responsive: false,
                  last_updated: FIXED_NOW_SEC - 1,
                  index: 2,
                },
              },
            },
          },
          { merge: true },
        );
        await narrate(page, 'b05 row appears — LAUNCHING', 5);
        await machineRef.set(
          {
            metrics: {
              processes: {
                [NEW_PROCESS_ID]: { status: 'RUNNING', responsive: true },
              },
            },
          },
          { merge: true },
        );
        await narrate(page, 'b05 flips to RUNNING', 8);

        // [b06] what happens on a crash (~28.0s). The banner copy is "restart
        // pending: {reason}" with approve / dismiss (MachineCardView.tsx:325,
        // :343, :358) — site admins only. The underlying field and testids
        // still say reboot; that split is deliberate and never spoken.
        await machineRef.set(
          {
            rebootPending: {
              active: true,
              processName: 'touchdesigner.exe',
              reason: 'process crashed repeatedly',
              timestamp: FIXED_NOW_SEC,
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
        await narrate(page, 'b06 relaunch attempts run out', 14);
        await highlight(page, focusCardAfter.getByTestId('reboot-pending-approve'), 1600);
        await narrate(page, 'b06 approve', 8);
        await highlight(page, focusCardAfter.getByTestId('reboot-pending-dismiss'), 1600);
        await narrate(page, 'b06 dismiss', 7);

        // [b07] day-to-day controls (~19.6s). These are NOT hover-revealed —
        // they render for every site admin: the off / always on / scheduled
        // segmented control with its schedule gear inside the "scheduled"
        // segment, then edit (pencil) and duplicate, with restart and kill
        // floated right. Duplicate clones the config as "… (copy)" in launch
        // mode off; it is shown in the pass but never named.
        const focusCardFinal = page
          .getByTestId('machine-card')
          .filter({ hasText: 'td-control-room' });
        // The card now holds three process rows. `.first()` on the container
        // filter picks the wrapper of the seeded touchdesigner.exe row (index 0
        // in the fixture), so its duplicated segment buttons need a trailing
        // `.first()`; restart/kill are already unique because their aria-labels
        // carry the process name.
        const tdRow = focusCardFinal
          .locator('div')
          .filter({ hasText: /^touchdesigner\.exe/ })
          .first();
        await centerInView(page, tdRow);
        await highlight(page, tdRow.getByRole('button', { name: /^always on$/ }).first(), 1500);
        await narrate(page, 'b07 launch-mode segments', 5);
        // The schedule gear inside the "scheduled" segment — icon-only, so it
        // is reachable only by testid (added alongside this scene).
        await highlight(page, tdRow.getByTestId('process-row-configure-schedule').first(), 1500);
        await narrate(page, 'b07 schedule gear', 4);
        await highlight(page, tdRow.getByRole('button', { name: /^restart touchdesigner\.exe$/ }), 1500);
        await highlight(page, tdRow.getByRole('button', { name: /^kill touchdesigner\.exe$/ }), 1500);
        await narrate(page, 'b07 restart and kill', 6);
        // The pencil is icon-only with no accessible name; the lucide class is
        // the repo's standard fallback for that case.
        await highlight(page, tdRow.locator('button:has(svg.lucide-pencil)').first(), 1500);
        await highlight(page, tdRow.getByRole('button', { name: /^duplicate touchdesigner\.exe$/ }), 1500);
        await narrate(page, 'b07 edit and duplicate', 6);
      },
    );
  } finally {
    await ctx.cleanup();
  }
});
