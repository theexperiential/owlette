/**
 * Scene — episode 12, "hoot — manage machines by chat". All SCREEN capture,
 * no B-ROLL. VO durations from voiceover/out/12-cortex/ (ffprobe):
 *   b01 what hoot is             ~20.8s  → seeded incident chat at /hoot/<id>
 *   b02 one-time setup             ~21.2s  → account settings → hoot tab
 *   b03 pick what it's talking to  ~16.4s  → MachineSelector at the top of the chat
 *   b04 ask a question             ~23.0s  → scroll the user→assistant turn
 *   b05 ask it to act              ~36.8s  → scroll to the act/tool-call turn
 *   b06 guardrails                 ~30.3s  → per-machine hoot active/inactive toggle
 *
 * b04/b05 scroll and highlight, never type: a real prompt needs a live LLM, so
 * the seeded conversation already holds the turn being narrated.
 *
 * b05 must NOT script a "hoot pauses to confirm" beat — `requiresConfirmation`
 * is unimplemented and tier-3 tools auto-run.
 *
 * Reuses the screenshots harness verbatim (`diagnose-cortex-chat` fixture:
 * LLM key bypass, focus conversation `screenshot-cortex-${siteId}`, filler
 * chats, media-server-stage machine + 03:14 incident transcript).
 *
 * Run:  cd web && npm run videos -- --grep "episode 12"
 * Out:  web/e2e/.output/videos/12-cortex.mp4
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
  clickWithCursor,
  centerInView,
} from './video-helpers';

test('episode 12 — hoot — manage machines by chat', async ({ browser }) => {
  const ctx = await seedScreenshotFixtures('diagnose-cortex-chat');
  const conversationId = `screenshot-cortex-${ctx.siteId}`;
  try {
    // Auto-select the seeded site on load.
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    await recordScene(
      browser,
      '12-cortex',
      { baseURL: E2E_BASE_URL, storageState: roleState('admin').storageState },
      async (page) => {
        // [b01] what hoot is — settle on the seeded incident chat (~20.8s VO).
        await openForCapture(page, `/hoot/${conversationId}`);
        // Title + the assistant's "access violation" answer should be visible.
        await expect(
          page.getByText('03:14 incident', { exact: false }).first(),
        ).toBeVisible();
        await expect(
          page.getByText('access violation', { exact: false }),
        ).toBeVisible();
        await narrate(page, 'b01 hoot chat — settle', 21);

        // [b02] one-time setup — account settings → hoot tab (~21.2s VO).
        const userMenuTrigger = page.getByTestId('user-menu-trigger');
        await clickWithCursor(page, userMenuTrigger);
        const accountSettingsItem = page.getByRole('menuitem', { name: /account settings/i });
        await expect(accountSettingsItem).toBeVisible();
        await clickWithCursor(page, accountSettingsItem);

        const settingsDialog = page.getByRole('dialog'); // VisuallyHidden DialogTitle
        await expect(settingsDialog).toBeVisible();
        const hootTab = settingsDialog.getByRole('button', { name: /^hoot$/i }).first();
        await clickWithCursor(page, hootTab);
        // Provider + model + api key fields render.
        await expect(settingsDialog.locator('#llmProvider')).toBeVisible();
        await expect(settingsDialog.locator('#llmApiKey')).toBeVisible();
        await narrate(page, 'b02 hoot setup tab', 21);

        // Close the dialog before navigating back to the chat surface.
        await page.keyboard.press('Escape');
        await expect(settingsDialog).not.toBeVisible();
        await page.waitForTimeout(400);

        // [b03] pick what it's talking to — machine selector at the top (~16.4s VO).
        const machineSelector = page.getByLabel('hoot target');
        await centerInView(page, machineSelector);
        await highlight(page, machineSelector, 1800);
        // Open the selector to surface the "All Machines" + per-machine options.
        await clickWithCursor(page, machineSelector);
        await page.waitForTimeout(400);
        const allMachinesOption = page
          .getByRole('option', { name: /All Machines/i })
          .first();
        await expect(allMachinesOption).toBeVisible();
        await highlight(page, allMachinesOption, 1400);
        await narrate(page, 'b03 selector open', 11);
        // Close it without changing selection.
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        await narrate(page, 'b03 close selector', 5);

        // [b04] ask a question — frame the user→assistant turn (~23.0s VO).
        const userQuestion = page.getByText('what crashed at 3am?', { exact: false });
        await centerInView(page, userQuestion);
        await highlight(page, userQuestion, 1800);
        await narrate(page, 'b04 user question', 6);
        const assistantAnswer = page.getByText('access violation', { exact: false });
        await centerInView(page, assistantAnswer);
        await highlight(page, assistantAnswer, 2200);
        await narrate(page, 'b04 hoot diagnosis', 11);
        // The inline tool-call card the assistant turn renders.
        const toolCard = page.getByText(/checklogs|checkLogs|matches/i).first(); // VERIFY — ToolCallCard label format
        await centerInView(page, toolCard);
        await highlight(page, toolCard, 1800);
        await narrate(page, 'b04 tool-call inline', 6);

        // [b05] ask it to act — frame the follow-up turn (~36.8s VO).
        const followUp = page.getByText('is it likely to recur tonight?', { exact: false });
        await centerInView(page, followUp);
        await highlight(page, followUp, 1800);
        await narrate(page, 'b05 follow-up question', 8);
        const recurrenceAnswer = page.getByText('low risk for tonight', { exact: false });
        await centerInView(page, recurrenceAnswer);
        await highlight(page, recurrenceAnswer, 2200);
        await narrate(page, 'b05 recurrence answer', 16);
        // Highlight the ChatInput so viewers see where they'd type next.
        const chatInput = page.getByRole('textbox').last(); // VERIFY — the ChatInput textarea is the last textbox on the page
        await centerInView(page, chatInput);
        await highlight(page, chatInput, 1800);
        await narrate(page, 'b05 chat input frame', 13);

        // [b06] guardrails — the per-machine hoot on/off toggle (~30.3s VO).
        // Only renders for a SINGLE selected machine, so switch off "All
        // Machines" onto media-server-stage.
        await clickWithCursor(page, machineSelector);
        await page.waitForTimeout(400);
        const mediaServerOption = page
          .getByRole('option', { name: /media-server-stage/i })
          .first();
        await clickWithCursor(page, mediaServerOption);
        await page.waitForTimeout(600);

        const hootToggle = page.getByRole('button', { name: /hoot (active|inactive)/i });
        await expect(hootToggle).toBeVisible();
        await centerInView(page, hootToggle);
        await highlight(page, hootToggle, 2400);
        await narrate(page, 'b06 hoot on/off toggle', 30);
      },
    );
  } finally {
    await ctx.cleanup();
  }
});
