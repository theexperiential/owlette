/**
 * Scene — episode 1, "what is owlette?".
 *
 * b01 (cold open) and b02 (wordmark → fleet) are pure B-ROLL, assembled in the
 * editor. b03 and b04 are web capture. b05 is a B-ROLL montage whose
 * web-capturable frames this scene supplies — see the beat comment for which
 * frames come from here and which are lifted from other episodes.
 *
 * Rendered VO (voiceover/out/01-what-is-owlette/, ffprobe):
 *   b01 14.2s · b02 21.5s · b03 29.5s · b04 18.2s · b05 27.6s
 * b03 and b05 were revoiced for the v2 series; their dwells below are derived
 * from the current MP3s, not the 2026-05 takes.
 *
 * Reuses the screenshots harness: `dashboard-mixed-states` (10 machines, one
 * offline, five carrying managed processes) + the admin storageState, same
 * selectors as the screenshot specs.
 *
 * Run:  cd web && npm run videos -- --grep "episode 1"
 * Out:  web/e2e/.output/videos/01-what-is-owlette.mp4
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
  centerInView,
  clickWithCursor,
} from './video-helpers';

test('episode 1 — what is owlette?', async ({ browser }) => {
  const ctx = await seedScreenshotFixtures('dashboard-mixed-states');
  try {
    const db = getAdminDb();
    // Auto-select the seeded site on load (admin is also on the baseline site-A).
    await db
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    // b05's /hoot frame: without a saved key the page renders the no-key gate
    // instead of the chat shell, and the montage would show a setup prompt
    // where the narration says "the assistant built in".
    await db
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .collection('settings')
      .doc('llm')
      .set({ provider: 'openai', model: 'gpt-4o-mini', hasKey: true }, { merge: true });

    await recordScene(
      browser,
      '01-what-is-owlette',
      { baseURL: E2E_BASE_URL, storageState: roleState('admin').storageState },
      async (page) => {
        await openForCapture(page, '/dashboard');
        await expect(page.getByTestId('machine-card')).toHaveCount(10);

        // [b03] who it's for — slow pan across the fleet: online pills, the one
        // offline machine, usage bars at their natural five-band spread (~29.5s).
        // Do NOT grade the shot toward a green→red ramp; the narration describes
        // headroom vs pinned, which is what actually renders.
        await narrate(page, 'b03 fleet — settle', 3);
        await slowScrollToBottom(page, 19);
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await narrate(page, 'b03 fleet — rest at top', 8);

        // [b04] the one-glance promise — zoom into one card, top to bottom
        // (~18.2s). media-server-stage is the only fleet machine seeded with
        // BOTH per-device history and a three-entry process list, so the last
        // clause ("the exact apps it's supposed to be running") has something
        // on screen. The spoken "memory" maps to the tile the UI labels "ram" —
        // frame the card whole rather than resting on that label.
        const focusCard = page
          .getByTestId('machine-card')
          .filter({ hasText: 'media-server-stage' });
        await centerInView(page, focusCard);
        await highlight(page, focusCard, 2600);
        await narrate(page, 'b04 one card', 19);

        // [b05] what this series covers (~27.6s of VO over a fast montage).
        //
        // The editor cuts this at roughly one second per frame; the harness's
        // job is to hand it a usable few seconds of each. Supplied here:
        // the add-process dialog, the schedule editor, a machine's display
        // panel, and the hoot chat.
        //
        // NOT from this scene, by design:
        //   - the inno installer wizard — native capture (capture-native/).
        //   - the /deployments, /roosts and /talons frames — those pages are
        //     empty under `dashboard-mixed-states`, and episodes 10, 11 and 13
        //     already shoot them against seeds that populate them. Lift the
        //     frames from that footage rather than filming thin ones here.
        const addProcessButton = page
          .getByTestId('machine-card')
          .filter({ hasText: 'lobby-display' })
          .getByRole('button', { name: /add process/i });
        await centerInView(page, addProcessButton);
        await clickWithCursor(page, addProcessButton);
        await expect(page.getByRole('dialog')).toBeVisible();
        await narrate(page, 'b05 montage — add process dialog', 5);

        // Schedule editor: reached from the same dialog's launch-mode gear,
        // which opens the schedule section in every launch mode.
        await clickWithCursor(page, page.getByTestId('process-dialog-configure-schedule'));
        await narrate(page, 'b05 montage — schedule editor', 5);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(600);

        // Display panel on the card that carries a monitor profile.
        const displayButton = page
          .getByTestId('machine-card')
          .filter({ hasText: 'mainstage-led' })
          .getByTestId('open-display-panel');
        await centerInView(page, displayButton);
        await clickWithCursor(page, displayButton);
        await expect(page.getByTestId('display-layout-panel')).toBeVisible();
        await narrate(page, 'b05 montage — display panel', 5);

        // Last frame: hoot. The nav label and the route are both "hoot";
        // nothing in the UI reads "cortex" any more.
        await openForCapture(page, '/hoot');
        await narrate(page, 'b05 montage — hoot', 8);
      },
    );
  } finally {
    await ctx.cleanup();
  }
});
