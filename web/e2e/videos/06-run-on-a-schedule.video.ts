/**
 * Scene — episode 6, "run apps on a schedule".
 *
 * Rendered VO (voiceover/out/06-run-on-a-schedule/, ffprobe):
 *   b01 20.0s why schedule · b02 12.8s switch to scheduled
 *   b03 19.5s the schedule editor · b04 15.9s overnight windows
 *   b05 21.2s presets · b06 10.6s save it · b07 20.3s the machine can edit them too
 *
 * b07 IS A NATIVE SEGMENT. Its first half is the owlette desktop app's own
 * schedule editor (aria-label "edit schedule", testid `edit-schedule`) — the
 * Tauri app, driven over WebView2 CDP by the `desktop-screenshots` harness, not
 * by this scene and NOT by pywinauto. All this scene supplies for b07 is cover
 * footage plus the web-side contrast the beat lands on: the preset pills, which
 * the local app does not have.
 *
 * Uses the `automate-schedule-editor` screenshot fixture + admin storageState.
 * That fixture seeds no processes (its stills frame the reboot schedule), so
 * this scene pre-seeds a "show player" in `launch_mode: 'always'` — with stored
 * schedule windows, which b02's save depends on (see the seed comment): b05/b06
 * need the standalone ScheduleEditor dialog (preset bar + "save schedule")
 * reached from the row's gear, not the inline ProcessDialog editor.
 *
 * TIMEZONE: do NOT frame the chip under the "configure schedule" title, or the
 * "times in …" label in the process dialog. The chip is labelled `source="site"`,
 * but the agent can never read the site document (firestore.rules scopes it to
 * its own machine subtree), so `site_timezone` is always None and every window
 * is evaluated on the machine's own local clock. Site-time evaluation is
 * designed, not wired. No timezone claim is spoken either way.
 *
 * Run:  cd web && npm run videos -- --grep "episode 6"
 * Out:  web/e2e/.output/videos/06-run-on-a-schedule.mp4
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

test('episode 6 — run apps on a schedule', async ({ browser }) => {
  const ctx = await seedScreenshotFixtures('automate-schedule-editor');
  try {
    const db = getAdminDb();
    // Auto-select the seeded site on load.
    await db
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    // Pre-seed a process on lobby-display so b02 has something to "open for
    // edit" and b03+ has a row with a schedule gear.
    const lobbyMachineId = 'lobby-display';
    const showProcId = 'proc-lobby-show';
    await db
      .collection('sites')
      .doc(ctx.siteId)
      .collection('machines')
      .doc(lobbyMachineId)
      .set(
        {
          metrics: {
            processes: {
              [showProcId]: {
                name: 'show-player.exe',
                status: 'RUNNING',
                pid: 4242,
                autolaunch: true,
                launch_mode: 'always',
                exe_path: 'C:\\Owlette\\bin\\show-player.exe',
                file_path: '',
                cwd: 'C:\\Owlette\\bin',
                priority: 'Normal',
                visibility: 'Show',
                time_delay: '0',
                time_to_init: '5',
                relaunch_attempts: '3',
                responsive: true,
                last_updated: FIXED_NOW_SEC - 30,
                index: 0,
              },
            },
          },
        },
        { merge: true },
      );
    await db
      .collection('config')
      .doc(ctx.siteId)
      .collection('machines')
      .doc(lobbyMachineId)
      .set(
        {
          processes: [
            {
              id: showProcId,
              name: 'show-player.exe',
              launch_mode: 'always',
              // Windows are stored even while the mode is `always` — the dialog
              // says so ("saved with the process — switch to scheduled whenever
              // you want these windows to run it", dashboard/page.tsx:1516), and
              // b02 NEEDS them: clicking the `scheduled` segment only moves
              // launch_mode, and the inline editor's default block is display-only
              // until the user edits it (page.tsx:155-159), so a process seeded
              // with `schedules: null` saves as scheduled-with-no-windows and the
              // route 400s `missing_schedules` (processPayloadValidation.ts:326-331)
              // — the dialog then stays open on the error toast. Mirrors
              // DEFAULT_SCHEDULE (lib/scheduleDefaults.ts:49-51) so the frame is
              // the same weekday 09–17 block the editor would have drawn.
              schedules: [
                { days: ['mon', 'tue', 'wed', 'thu', 'fri'], ranges: [{ start: '09:00', stop: '17:00' }] },
              ],
            },
          ],
        },
        { merge: true },
      );

    await recordScene(
      browser,
      '06-run-on-a-schedule',
      { baseURL: E2E_BASE_URL, storageState: roleState('admin').storageState },
      async (page) => {
        await openForCapture(page, '/dashboard');

        // [b01] why schedule — frame the lobby-display card (~20.0s).
        const lobbyCard = page
          .getByTestId('machine-card')
          .filter({ hasText: 'lobby-display' });
        await expect(lobbyCard).toBeVisible();
        await centerInView(page, lobbyCard);
        await highlight(page, lobbyCard, 2600);
        await narrate(page, 'b01 why schedule', 21);

        // [b02] switch to scheduled (~12.8s). The process list is EXPANDED by
        // default (seed.ts user prefs + the AuthContext default), so the single
        // seeded process's pencil is the only edit button on this card.
        const editButton = lobbyCard.locator('button:has(svg.lucide-pencil)').first();
        await clickWithCursor(page, editButton);
        // Scoped by accessible name (DialogTitle "edit process",
        // dashboard/page.tsx:1306-1309): the dashboard mounts several dialogs
        // and a bare getByRole('dialog') matches whichever one is open — a
        // strict-mode violation waiting for the delete-confirm or the standalone
        // schedule dialog to join it.
        const processDialog = page.getByRole('dialog', { name: /edit process/i });
        await expect(processDialog).toBeVisible();
        // Frame the gear while the mode still reads "always on": it opens the
        // same schedule section in EVERY launch mode, storing the windows for
        // later rather than switching anything.
        await highlight(page, page.getByTestId('process-dialog-configure-schedule'), 2200);
        await narrate(page, 'b02 the gear works in any mode', 6);
        await clickWithCursor(page, processDialog.getByRole('button', { name: 'scheduled' }));
        await narrate(page, 'b02 inline editor + week bar appear', 8);

        // [b03] the schedule editor (~19.5s). Save the process (now scheduled),
        // then open the STANDALONE configure-schedule dialog from the row gear —
        // that is the one carrying the preset bar and "save schedule".
        await clickWithCursor(page, processDialog.getByRole('button', { name: 'save changes' }));
        // The dialog closes ONLY on a 2xx (handleSaveProcess, page.tsx:596-608);
        // a rejected PATCH leaves it open behind an error toast, so this is the
        // assertion that catches a bad payload rather than filming one.
        await expect(processDialog).toBeHidden();
        await page.waitForTimeout(600);
        const lobbyCardAfter = page
          .getByTestId('machine-card')
          .filter({ hasText: 'lobby-display' });
        // Icon-only gear inside the "scheduled" segment; its label lives in a
        // tooltip portal, so the testid is the only handle that resolves before
        // a hover (added alongside this scene).
        const rowGear = lobbyCardAfter.getByTestId('process-row-configure-schedule').first();
        await centerInView(page, rowGear);
        await clickWithCursor(page, rowGear);
        await expect(page.getByText('configure schedule', { exact: true })).toBeVisible();
        await narrate(page, 'b03 day pills + time range', 20);

        // [b04] overnight windows (~15.9s). The seeded admin preference is 12h
        // and the default block ends 17:00, so a bare "06:00" parses as 6 PM and
        // the frame would read 11pm→6pm — contradicting the narration. Type
        // "6am" and let the picker normalise it.
        const timeInputs = page.locator('input[title^="Type a time"]');
        await clickWithCursor(page, timeInputs.nth(0));
        await timeInputs.nth(0).fill('11pm');
        await page.keyboard.press('Enter');
        await clickWithCursor(page, timeInputs.nth(1));
        await timeInputs.nth(1).fill('6am');
        await page.keyboard.press('Enter');
        const plusOneDay = page.getByText('+1 day', { exact: true });
        await expect(plusOneDay).toBeVisible();
        await highlight(page, plusOneDay, 2400);
        await narrate(page, 'b04 crosses midnight, +1 day badge', 17);

        // [b05] presets (~21.2s).
        const businessHoursPill = page.getByRole('button', { name: 'business hours' });
        await highlight(page, businessHoursPill, 1400);
        await highlight(page, page.getByRole('button', { name: 'extended hours' }), 1400);
        await highlight(page, page.getByRole('button', { name: 'weekday 24h' }), 1400);
        await highlight(page, page.getByRole('button', { name: '24/7' }), 1400);
        await narrate(page, 'b05 built-in preset pills', 10);
        // Apply "business hours" so the block resets to a clean weekday 09–17 —
        // FIXED_NOW is 07:30 in the site's timezone, i.e. OUTSIDE it, which is
        // what puts b06's banner on screen.
        await clickWithCursor(page, businessHoursPill);
        await page.waitForTimeout(400);
        await clickWithCursor(page, page.getByRole('button', { name: /new preset/i }));
        await typewrite(page, page.getByPlaceholder('preset name'), 'opening hours', 55);
        await narrate(page, 'b05 save your own preset', 11);

        // [b06] save it (~10.6s). Dismiss the inline "new preset" form with its
        // own X, never Escape — Escape closes the WHOLE dialog and takes "save
        // schedule" with it. The X is icon-only and unnamed, so it is reached
        // through the form that owns it.
        await clickWithCursor(
          page,
          page.locator('form:has(input[placeholder="preset name"]) button:has(svg.lucide-x)'),
        );
        await page.waitForTimeout(300);
        const outsideWindowBanner = page.getByText(
          'this looks outside the current window — a machine outside it will stop the process shortly after saving.',
          { exact: true },
        );
        await expect(outsideWindowBanner).toBeVisible();
        await highlight(page, outsideWindowBanner, 2400);
        await narrate(page, 'b06 outside-window warning', 6);
        await clickWithCursor(page, page.getByRole('button', { name: 'save schedule' }));
        await narrate(page, 'b06 saved', 5);

        // [b07] the machine can edit them too (~20.3s) — NATIVE SEGMENT.
        // The desktop app's own schedule editor is filmed by the
        // desktop-screenshots video sibling (CDP over WebView2); this pass only
        // supplies cover for the cut and the web-side contrast the beat lands
        // on. Do not try to shoot the local app from here.
        const lobbyCardFinal = page
          .getByTestId('machine-card')
          .filter({ hasText: 'lobby-display' });
        await centerInView(page, lobbyCardFinal);
        await highlight(page, lobbyCardFinal, 2600);
        await narrate(page, 'b07 cover — the native insert goes here', 12);
        // Reopen the editor so the pills — the thing the local app lacks — land
        // the closing contrast.
        await clickWithCursor(
          page,
          lobbyCardFinal.getByTestId('process-row-configure-schedule').first(),
        );
        await expect(page.getByText('configure schedule', { exact: true })).toBeVisible();
        await highlight(page, page.getByRole('button', { name: 'business hours' }), 2400);
        await narrate(page, 'b07 presets are the web-only half', 9);
      },
    );
  } finally {
    await ctx.cleanup();
  }
});
