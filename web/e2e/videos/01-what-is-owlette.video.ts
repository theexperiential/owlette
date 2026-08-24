/**
 * Scene — episode 1, "what is owlette?".
 *
 * Only b03 (fleet at a glance, ~33.8s VO) and b04 (one machine card, ~18.2s)
 * are web capture; b01/b02/b05 are b-roll assembled in the editor.
 *
 * Reuses the screenshots harness: `dashboard-mixed-states` (10 machines, one
 * offline, varied usage) + the admin storageState, same selectors.
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

        // [b03] slow pan across the fleet: online pills, the one offline
        // machine, usage bars at varying levels.
        await narrate(page, 'b03 fleet — settle', 3);
        await slowScrollToBottom(page, 24);
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await narrate(page, 'b03 fleet — rest at top', 7);

        // [b04] one card: status pill, sparklines, process list.
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
