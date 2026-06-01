/**
 * Scene — episode 1, "what is owlette?" (the series opener).
 *
 * ep01 is mostly B-ROLL that gets assembled in the editor, NOT web capture:
 *   - b01 (cold open)  → external footage: dark gallery at 3am, frozen display
 *   - b02 (what it is) → owlette wordmark graphic, then a cut to the dashboard
 *   - b05 (series map) → a montage stitched from the OTHER episodes' captures
 * Only b03 (the fleet at a glance) and b04 (one machine card) are real web shots, so
 * that's all this scene records. dwell lengths are sized to the rendered VO MP3s:
 *   b03 ≈ 33.8s, b04 ≈ 18.2s  (voiceover/out/01-what-is-owlette/).
 *
 * Reuses the screenshots harness verbatim: the `dashboard-mixed-states` fixture (10
 * seeded machines, one offline, varied usage) + the admin role storageState. Selectors
 * mirror the screenshot specs (machine-card, the 'media-server-stage' card).
 *
 * Run:  cd web && npm run videos -- --grep "episode 1"
 * Out:  web/e2e/.output/videos/01-what-is-owlette.webm
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
} from './video-helpers';

test('episode 1 — what is owlette?', async ({ browser }) => {
  const ctx = await seedScreenshotFixtures('dashboard-mixed-states');
  try {
    // Auto-select the seeded site on load (admin is also on the baseline site-A).
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    await recordScene(
      browser,
      '01-what-is-owlette',
      { baseURL: E2E_BASE_URL, storageState: roleState('admin').storageState },
      async (page) => {
        await openForCapture(page, '/dashboard');
        await expect(page.getByTestId('machine-card')).toHaveCount(10);

        // [b03] who it's for — a slow pan across the seeded fleet (~33.8s VO).
        // Green online pills, the one red offline machine, usage bars at varying levels.
        await narrate(page, 'b03 fleet — settle', 3);
        await slowScrollToBottom(page, 24);
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await narrate(page, 'b03 fleet — rest at top', 7);

        // [b04] the one-glance promise — frame a single card (~18.2s VO).
        // Status pill, cpu/gpu/memory sparklines, the process list underneath.
        const focusCard = page
          .getByTestId('machine-card')
          .filter({ hasText: 'media-server-stage' });
        await centerInView(page, focusCard);
        await highlight(page, focusCard, 2600);
        await narrate(page, 'b04 one card', 18);
      },
    );
  } finally {
    await ctx.cleanup();
  }
});
