/**
 * Scene — episode 13, "talons: rules that watch and act". All SCREEN beats.
 *
 * Rendered VO (voiceover/out/13-talons/, ffprobe):
 *   b01 19.0s a wall goes black at 3am · b02 33.3s trigger, condition, outputs
 *   b03 23.1s build one live · b04 24.8s start from a preset
 *   b05 27.6s the visual check · b06 26.5s let hoot act
 *   b07 22.6s run history, cooldown, auto-disable · b08 26.4s the one to turn on first
 *
 * Fixture `automate-talons-list` (seven talons spanning every trigger kind,
 * both condition kinds and all four output families; four machines, none with
 * processes) + the admin storageState — `command` outputs only appear in the
 * picker for a site admin.
 *
 * TWO HONEST COMPROMISES, both staged rather than faked:
 *
 * 1. b03 "build one live" really does create a talon — trigger, condition,
 *    outputs, name, save — so the row that appears at the end of the beat is a
 *    real write, not a seeded one. It brings the list to EIGHT rows for the rest
 *    of the take; `screenshots/automate.spec.ts` still sees seven because it
 *    re-seeds its own fixture.
 *
 * 2. b05's "verdict: fail" cut and b07's run history are SEEDED runs, not live
 *    firings. Forcing a real visual-check failure needs a machine with an agent,
 *    a screenshot and an llm key — none of which exist in the emulator — and the
 *    fixture writes talon docs only, so an expanded row would otherwise read
 *    "no runs yet". The seeded docs use the real `TalonRunDoc` shape
 *    (lib/talons/types.ts:369-400) so nothing on screen is invented.
 *
 * LIVE-DEMO HAZARD (does not apply to this scene, but does to any real-machine
 * take of the same beats): hoot's machine-side tools fetch a ~240 MB Claude CLI
 * into %ProgramData%\Owlette\cache\claude-cli on first use, so a freshly paired
 * demo machine cannot run a hoot action until that lands. Pre-warm it the day
 * before.
 *
 * Run:  cd web && npm run videos -- --grep "episode 13"
 * Out:  web/e2e/.output/videos/13-talons.mp4
 */

import { Timestamp } from 'firebase-admin/firestore';
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
  slowScrollToBottom,
  centerInView,
  clickWithCursor,
  typewrite,
} from './video-helpers';

// ~195s of dwell plus seeding, context creation and recorder start does not fit
// the config's 5-minute per-test default.
test.setTimeout(8 * 60_000);

/** Seconds before FIXED_NOW → Timestamp, mirroring the fixture's `tsAgo`. */
const tsAgo = (secondsAgo: number): Timestamp =>
  Timestamp.fromMillis(FIXED_NOW_MS - secondsAgo * 1000);

test('episode 13 — talons: rules that watch and act', async ({ browser }) => {
  const ctx = await seedScreenshotFixtures('automate-talons-list');
  try {
    const db = getAdminDb();
    await db
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    // The template picker groups the six built-ins by whether they run as-is;
    // with an llm key saved, all six sit under "ready to use" — which is the
    // state b04 narrates.
    await db
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .collection('settings')
      .doc('llm')
      .set({ provider: 'openai', model: 'gpt-4o-mini', hasKey: true }, { merge: true });

    // Run history for `talon-doors-open` — b05's failing verdict and b07's list.
    // `deleteSiteSubtree` already drops `talon_runs`, so no extra cleanup.
    const runsRef = db.collection('sites').doc(ctx.siteId).collection('talon_runs');
    await runsRef.doc('run-doors-open-fail').set({
      talonId: 'talon-doors-open',
      talonName: 'doors open — lobby wall is live',
      triggerType: 'schedule',
      triggerSummary: 'schedule 09:45',
      machineId: 'lobby-wall',
      machineName: 'lobby-wall',
      status: 'succeeded',
      startedAt: tsAgo(60 * 12),
      completedAt: tsAgo(60 * 12 - 9),
      durationMs: 9_140,
      condition: {
        type: 'visual_check',
        verdict: 'fail',
        confidence: 0.91,
        reason: 'the wall is showing the windows desktop, not the content loop',
      },
      outputs: [
        { type: 'cortex', status: 'sent', detail: 'restarted touchdesigner' },
        { type: 'email', status: 'sent' },
      ],
      correlationId: 'corr-doors-open-fail',
      chatId: `screenshot-cortex-auto-${ctx.siteId}`,
    });
    await runsRef.doc('run-doors-open-pass').set({
      talonId: 'talon-doors-open',
      talonName: 'doors open — lobby wall is live',
      triggerType: 'schedule',
      triggerSummary: 'schedule 09:45',
      machineId: 'lobby-wall',
      machineName: 'lobby-wall',
      // A passing visual check short-circuits before the outputs run, so
      // `skipped` IS what a healthy wall looks like in the history.
      status: 'skipped',
      startedAt: tsAgo(60 * 60 * 24 - 60 * 15),
      completedAt: tsAgo(60 * 60 * 24 - 60 * 15 - 6),
      durationMs: 6_020,
      condition: {
        type: 'visual_check',
        verdict: 'pass',
        confidence: 0.97,
        reason: 'the content loop is on screen, no dialogs',
      },
      outputs: [],
      correlationId: 'corr-doors-open-pass',
    });

    await recordScene(
      browser,
      '13-talons',
      { baseURL: E2E_BASE_URL, storageState: roleState('admin').storageState },
      async (page) => {
        // [b01] a wall goes black at 3am (~19.0s) — slow scroll down the seven
        // seeded talons.
        await openForCapture(page, '/talons');
        await expect(page.getByTestId('talon-row')).toHaveCount(7);
        await expect(page.getByText('doors open — lobby wall is live')).toBeVisible();
        await narrate(page, 'b01 the list — settle', 4);
        await slowScrollToBottom(page, 11);
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await narrate(page, 'b01 rest at top', 5);

        // [b02] trigger, condition, outputs (~33.3s) — the three cards left to
        // right with the connector wires between them.
        await clickWithCursor(page, page.getByTestId('talon-create'));
        const editor = page.getByTestId('talon-editor');
        await expect(editor).toBeVisible();
        await narrate(page, 'b02 the pipeline, left to right', 9);
        await centerInView(page, editor.getByTestId('trigger-type'));
        await highlight(page, editor.getByTestId('trigger-type'), 2200);
        await clickWithCursor(page, editor.getByTestId('trigger-type'));
        await page.waitForTimeout(400);
        await expect(page.getByRole('option', { name: 'on a schedule' })).toBeVisible();
        await expect(page.getByRole('option', { name: 'when a metric crosses' })).toBeVisible();
        await expect(page.getByRole('option', { name: 'when an event happens' })).toBeVisible();
        await narrate(page, 'b02 the three triggers', 12);
        // Close the select before the next two highlights: the Radix popover and
        // its modal overlay sit on top of the condition and output cards, so
        // outlining them with it open frames a covered card for 12s.
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        await highlight(page, editor.getByTestId('condition-type'), 2200);
        await highlight(page, editor.getByTestId('output-row').first(), 2200);
        await narrate(page, 'b02 condition and outputs; authoring is admin work', 12);

        // [b03] build one live (~23.1s). Trigger → event → process_crash;
        // condition stays "always run outputs"; machines stay "all machines";
        // outputs: restart process, then email.
        await clickWithCursor(page, editor.getByTestId('trigger-type'));
        await page.waitForTimeout(400);
        await clickWithCursor(page, page.getByRole('option', { name: 'when an event happens' }));
        await expect(editor.getByTestId('trigger-event')).toBeVisible();
        // Each event is a <label> wrapping its checkbox and a mono name span;
        // anchor on the exact name rather than list order.
        await clickWithCursor(
          page,
          editor
            .getByTestId('trigger-event')
            .locator('label')
            .filter({ hasText: /^process_crash$/ })
            .getByRole('checkbox'),
        );
        await narrate(page, 'b03 trigger: process crash', 6);

        const firstOutput = editor.getByTestId('output-row').first();
        await centerInView(page, firstOutput);
        await clickWithCursor(page, firstOutput.getByRole('combobox', { name: 'output 1 type' }));
        await clickWithCursor(page, page.getByRole('option', { name: 'command', exact: true }));
        await clickWithCursor(page, firstOutput.getByRole('combobox', { name: 'output 1 command' }));
        await clickWithCursor(page, page.getByRole('option', { name: 'restart process' }));
        // The scoped machines carry no processes, so the picker collapses to the
        // free-text name field (OutputsCard.tsx:223).
        await typewrite(
          page,
          firstOutput.getByRole('textbox', { name: 'output 1 process name' }),
          'TouchDesigner',
          55,
        );
        await narrate(page, 'b03 output 1: restart the process', 8);
        await clickWithCursor(page, editor.getByTestId('output-add'));
        await narrate(page, 'b03 output 2: email', 4);

        await typewrite(page, editor.locator('#talon-name'), 'touchdesigner crash recovery', 45);
        await clickWithCursor(page, editor.getByTestId('talon-editor-save'));
        await expect(editor).not.toBeVisible({ timeout: 20_000 });
        await expect(page.getByTestId('talon-row')).toHaveCount(8);
        await narrate(page, 'b03 the row appears', 5);

        // [b04] start from a preset (~24.8s).
        await clickWithCursor(page, page.getByTestId('talon-create'));
        const editorAgain = page.getByTestId('talon-editor');
        await expect(editorAgain).toBeVisible();
        await clickWithCursor(page, editorAgain.getByTestId('talon-template-picker'));
        await page.waitForTimeout(400);
        // With a key saved, every built-in sits under "ready to use"; without
        // one the five ai-backed presets drop to "needs a detail".
        await expect(page.getByText('ready to use', { exact: true })).toBeVisible();
        await narrate(page, 'b04 six presets, grouped by readiness', 12);
        await clickWithCursor(page, page.getByRole('option', { name: 'morning wall check' }));
        await page.waitForTimeout(600);
        await narrate(page, 'b04 every field fills in', 13);

        // [b05] the visual check (~27.6s).
        await clickWithCursor(
          page,
          editorAgain.getByTestId('condition-type').getByRole('radio', { name: 'visual check' }),
        );
        const visualCheck = editorAgain.getByTestId('condition-visual-check');
        await expect(visualCheck).toBeVisible();
        await centerInView(page, visualCheck);
        await highlight(page, visualCheck.locator('#talon-condition-expectation'), 2600);
        await narrate(page, 'b05 what should be on screen, in plain english', 13);
        await highlight(page, visualCheck.locator('#talon-condition-monitor'), 2200);
        await highlight(
          page,
          visualCheck.getByText('the outputs fire when the check FAILS', { exact: false }),
          2600,
        );
        // `highlight` returns as soon as it schedules the outline, so the three
        // above contribute nothing to the beat's length; 13 + 15 is what covers
        // the 27.6s MP3.
        await narrate(page, 'b05 monitor + outputs-fire-on-fail', 15);

        // [b06] let hoot act (~26.5s) — change an output to hoot, show the
        // directive box and the switch, toggle on, hold, toggle back off.
        const presetOutput = editorAgain.getByTestId('output-row').first();
        await centerInView(page, presetOutput);
        await clickWithCursor(page, presetOutput.getByRole('combobox', { name: 'output 1 type' }));
        await clickWithCursor(page, page.getByRole('option', { name: 'hoot', exact: true }));
        await highlight(page, presetOutput.locator('#talon-output-0-directive'), 2600);
        await narrate(page, 'b06 the directive', 9);
        const allowActions = presetOutput.getByRole('switch', { name: 'output 1 let hoot act' });
        await centerInView(page, allowActions);
        await highlight(page, allowActions, 2200);
        await clickWithCursor(page, allowActions);
        await narrate(page, 'b06 on: restart, restart service, free disk', 10);
        await clickWithCursor(page, allowActions);
        await narrate(page, 'b06 never scripts, files, deploys or reboots', 8);

        // [b08, staged from here] the one to turn on first (~26.4s). Shot from
        // the PRESET, whose "let hoot act" switch is off — the seeded
        // `talon-update-guard` row is written with allowActions:true and would
        // contradict the line about it arriving without permission to act.
        await clickWithCursor(page, editorAgain.getByTestId('talon-template-picker'));
        await page.waitForTimeout(400);
        await clickWithCursor(page, page.getByRole('option', { name: 'update guard' }));
        await page.waitForTimeout(600);
        const guardOutput = editorAgain.getByTestId('output-row').first();
        await centerInView(page, guardOutput);
        await narrate(page, 'b08 sunday 07:00 + one hoot output', 11);
        const guardSwitch = guardOutput.getByRole('switch', { name: 'output 1 let hoot act' });
        await expect(guardSwitch).toHaveAttribute('data-state', 'unchecked');
        await highlight(page, guardSwitch, 2400);
        await clickWithCursor(page, guardSwitch);
        await narrate(page, 'b08 turn on let hoot act', 8);
        // Leave without saving — b08 ends on the existing row, not a ninth talon.
        await page.keyboard.press('Escape');
        await page.waitForTimeout(700);

        // [b07] run history, cooldown, auto-disable (~22.6s). Expand the seeded
        // wall-check talon: the failing run (with its `verdict: fail` line and
        // the "view hoot chat" link) sits above the passing one.
        const doorsOpenRow = page
          .getByTestId('talon-row')
          .filter({ hasText: 'doors open — lobby wall is live' });
        await centerInView(page, doorsOpenRow);
        await clickWithCursor(
          page,
          doorsOpenRow.getByRole('button', { name: 'expand run history' }),
        );
        await expect(page.getByTestId('talon-run-row').first()).toBeVisible({ timeout: 15_000 });
        await highlight(page, page.getByTestId('talon-run-row').first(), 2600);
        await narrate(page, 'b07 recent runs — verdict, outputs sent, duration', 10);
        await highlight(page, page.getByRole('link', { name: /view hoot chat/i }).first(), 2200);
        await narrate(page, 'b07 into the hoot chat it started', 5);
        await highlight(page, doorsOpenRow.getByTestId('talon-rerun'), 1800);
        await highlight(page, doorsOpenRow.getByTestId('talon-toggle'), 1800);
        await narrate(page, 'b07 run now, pause, cooldown, auto-disable', 8);

        // b08's closing pull-out: back to the update-guard row and the list.
        const guardRow = page
          .getByTestId('talon-row')
          .filter({ hasText: 'update guard — sundays' });
        await centerInView(page, guardRow);
        await highlight(page, guardRow, 2600);
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await narrate(page, 'b08 pull out to the whole list', 7);
      },
    );
  } finally {
    await ctx.cleanup();
  }
});
