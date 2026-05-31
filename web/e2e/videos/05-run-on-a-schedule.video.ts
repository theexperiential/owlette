/**
 * Scene — episode 5, "run apps on a schedule".
 *
 * Every beat in this episode is a SCREEN beat (web capture). No B-ROLL to skip.
 * (Note: the end of b06 mentions "briefly cut to the agent GUI showing the
 * saved schedule summary, read-only" — that's a NATIVE-CAPTURE shot assembled
 * in the editor, NOT part of this web scene. We just hold on the web for the
 * full b06 dwell so the VO drops cleanly underneath the editor's cut.)
 *
 * Beats and their rendered VO durations (voiceover/out/05-run-on-a-schedule/):
 *   b01 ≈ 20.0s — why schedule (frame the lobby-display card)
 *   b02 ≈ 12.8s — switch to scheduled (open process for edit, flip launch mode)
 *   b03 ≈ 19.5s — the schedule editor (configure-schedule dialog, day pills + time range)
 *   b04 ≈ 15.9s — overnight windows (set 23:00 → 06:00, "+1 day" badge appears)
 *   b05 ≈ 21.2s — presets (preset pills + new preset)
 *   b06 ≈ 22.7s — outside the window (save schedule + warning)
 *
 * Reuses the screenshots harness verbatim: the `automate-schedule-editor`
 * fixture (lobby-display + media-server-stage, a reboot schedule + a custom
 * "museum hours" preset on top of the four built-in presets) + the admin role
 * storageState.
 *
 * Pre-record state hacks (same pattern as ep01's `lastSiteId` set):
 *   1. Auto-select the seeded site on load.
 *   2. Seed a "show player" process on lobby-display in `launch_mode: 'always'`
 *      state so the user can open it for edit, flip it to Scheduled, and
 *      reopen the standalone `ScheduleEditor` dialog via the row's gear icon
 *      (the standalone dialog — not the inline ProcessDialog editor — is the
 *      one that has the preset bar + "save schedule" button referenced in
 *      b05/b06). The `automate-schedule-editor` fixture intentionally seeds
 *      no processes because the static screenshots frame the reboot schedule.
 *
 * Run:  cd web && npm run videos -- --grep "episode 5"
 * Out:  web/e2e/.output/videos/05-run-on-a-schedule.mp4
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

// Mirror of fixtures.ts FIXED_NOW_MS — duplicated here to avoid a new import
// (per scene authoring rules). Keep in sync if the constant ever changes.
const FIXED_NOW_MS = Date.UTC(2026, 3, 15, 14, 30, 0);
const FIXED_NOW_SEC = Math.floor(FIXED_NOW_MS / 1000);

test('episode 5 — run apps on a schedule', async ({ browser }) => {
  const ctx = await seedScreenshotFixtures('automate-schedule-editor');
  try {
    const db = getAdminDb();
    // Auto-select the seeded site on load.
    await db
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    // Pre-seed a process on lobby-display so the user has something to "open
    // for edit" in b02 and a row with a schedule gear to click for b03+.
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
              schedules: null,
            },
          ],
        },
        { merge: true },
      );

    await recordScene(
      browser,
      '05-run-on-a-schedule',
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
        await narrate(page, 'b01 why schedule', 20);

        // [b02] switch to scheduled — open the process for edit, flip launch mode (~12.8s).
        // NOTE: the original draft tried to click a "1 process" CollapsibleTrigger
        // first, but the process list is EXPANDED by default — the seeded admin
        // user prefs set `processesExpanded: true` (web/e2e/helpers/seed.ts:112)
        // and the AuthContext default is also `true` (contexts/AuthContext.tsx:185).
        // The collapsed trigger button (MachineCardView.tsx:724–751) is only
        // rendered when `!processesExpanded`, so it doesn't exist on load and
        // the show-player.exe row's pencil/edit button is already visible.
        // We pre-seeded exactly ONE process (show-player.exe) on the lobby card,
        // so the only pencil-icon button on this card is its edit button. Skip
        // the brittle row-text filter chain and scope directly to lobbyCard.
        const editButton = lobbyCard.locator('button:has(svg.lucide-pencil)').first();
        await clickWithCursor(page, editButton);
        await expect(page.getByRole('dialog')).toBeVisible();
        // In the ProcessDialog launch-mode segmented control, click "Scheduled".
        // The inline schedule editor + WeekSummaryBar appear in the dialog.
        const scheduledPill = page.getByRole('button', { name: 'Scheduled' }); // VERIFY: segmented control button literal text
        await clickWithCursor(page, scheduledPill);
        await narrate(page, 'b02 flip to scheduled', 13);

        // [b03] the schedule editor — save the process (now scheduled), then open
        // the standalone configure-schedule dialog via the row's gear (~19.5s).
        const saveProcessButton = page.getByRole('button', { name: 'save changes' }); // VERIFY: ProcessDialog footer in edit mode
        await clickWithCursor(page, saveProcessButton);
        await expect(page.getByRole('dialog')).not.toBeVisible();
        // The row is now in scheduled mode; the gear (Settings2 icon) appears
        // next to the "Scheduled" pill with tooltip "configure schedule".
        await page.waitForTimeout(500);
        const lobbyCardAfter = page
          .getByTestId('machine-card')
          .filter({ hasText: 'lobby-display' });
        const scheduledRow = lobbyCardAfter
          .locator('div')
          .filter({ hasText: /^show-player\.exe/ })
          .first(); // VERIFY: same row, re-located after Firestore listener tick
        const gearButton = scheduledRow.getByRole('button', { name: /configure schedule/i }); // VERIFY: tooltip-driven accessible name on the gear button
        await clickWithCursor(page, gearButton);
        // Standalone ScheduleEditor dialog — title "configure schedule".
        await expect(page.getByText('configure schedule', { exact: true })).toBeVisible();
        await narrate(page, 'b03 schedule editor', 19);

        // [b04] overnight windows — change the time range to 23:00 → 06:00 (~15.9s).
        // The default block has start 08:00 stop 17:00. TimePicker inputs all
        // share `title="Type a time (e.g. 9:00, 5pm, 17:00) or use ↑↓ arrows"`,
        // and there are exactly two in the default single-block editor (start,
        // stop). Once both are set the "+1 day" badge renders on the stop side.
        const timeInputs = page.locator('input[title^="Type a time"]'); // VERIFY: TimePicker inputs in ScheduleBlocksEditor; default block has two (start/stop)
        await clickWithCursor(page, timeInputs.nth(0));
        await timeInputs.nth(0).fill('23:00');
        await page.keyboard.press('Enter');
        await clickWithCursor(page, timeInputs.nth(1));
        await timeInputs.nth(1).fill('06:00');
        await page.keyboard.press('Enter');
        // Highlight the "+1 day" badge that should now appear.
        const plusOneDay = page.getByText('+1 day', { exact: true }); // VERIFY: literal label rendered by ScheduleBlocksEditor when range crosses midnight
        await highlight(page, plusOneDay, 2000);
        await narrate(page, 'b04 overnight + badge', 16);

        // [b05] presets — pan the preset pill row, then click "new preset" (~21.2s).
        const businessHoursPill = page.getByRole('button', { name: 'business hours' }); // VERIFY: built-in preset name; rendered as a pill <button>
        const extendedHoursPill = page.getByRole('button', { name: 'extended hours' });
        const weekday24Pill = page.getByRole('button', { name: 'weekday 24h' });
        const allDayPill = page.getByRole('button', { name: '24/7' });
        await highlight(page, businessHoursPill, 1400);
        await highlight(page, extendedHoursPill, 1400);
        await highlight(page, weekday24Pill, 1400);
        await highlight(page, allDayPill, 1400);
        // Apply "business hours" so the block resets to a clean weekday 09–17.
        await clickWithCursor(page, businessHoursPill);
        await page.waitForTimeout(400);
        // Click the "new preset" dashed-border pill.
        const newPresetButton = page.getByRole('button', { name: /new preset/i }); // VERIFY: button text "new preset" with Plus icon
        await clickWithCursor(page, newPresetButton);
        // Inline input appears; type a name.
        const presetNameInput = page.getByPlaceholder('preset name');
        await typewrite(page, presetNameInput, 'opening hours', 55);
        await narrate(page, 'b05 presets', 21);

        // [b06] outside the window — save the schedule and hold on the
        // resulting state (warning banner if FIXED_NOW is outside the window) (~22.7s).
        // First press Escape to clear the inline "new preset" form so it
        // doesn't intercept the upcoming save click.
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        // Save the schedule — footer button "save schedule".
        const saveScheduleButton = page.getByRole('button', { name: 'save schedule' }); // VERIFY: ScheduleEditor footer button
        await highlight(page, saveScheduleButton, 1600);
        await clickWithCursor(page, saveScheduleButton);
        await narrate(page, 'b06 save + outside-window note', 23);
      },
    );
  } finally {
    await ctx.cleanup();
  }
});
