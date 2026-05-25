/**
 * Scene — episode 3, "the dashboard, end to end".
 *
 * Reference implementation of a web-capture scene — and the ONLY scene implemented so
 * far. It covers episode 3 beats b01–b04: orient on the fleet, read a card, open a
 * metric detail panel, flip to list view. Beats b05–b06 (expand/collapse-all + nav
 * tour) and the other episodes' scenes are still to be built by copying this pattern.
 * The `narrate()` dwell after each action is sized to roughly match that beat's
 * voiceover so the MP3 drops straight underneath in the editor.
 *
 * Reuses the screenshots harness verbatim: the `dashboard-mixed-states` fixture (10
 * seeded machines) and the admin role storageState. Selectors are the same ones the
 * screenshot specs use (machine-card, view-toggle-list, machine-row, the "cpu" tile).
 *
 * Run:  cd web && npm run videos -- --grep "dashboard"
 * Out:  web/e2e/.output/videos/03-dashboard-tour.webm
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
  clickWithCursor,
  highlight,
} from './video-helpers';

test('episode 3 — dashboard tour', async ({ browser }) => {
  const ctx = await seedScreenshotFixtures('dashboard-mixed-states');
  try {
    // Auto-select the seeded site on load (admin is also on the baseline site-A).
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    await recordScene(
      browser,
      '03-dashboard-tour',
      { baseURL: E2E_BASE_URL, storageState: roleState('admin').storageState },
      async (page) => {
        // [b01] orientation — the fleet at a glance
        await openForCapture(page, '/dashboard');
        await expect(page.getByTestId('machine-card')).toHaveCount(10);
        await narrate(page, 'b01 orientation', 6);

        // [b02] card anatomy — draw the eye to a single card
        const focusCard = page
          .getByTestId('machine-card')
          .filter({ hasText: 'media-server-stage' });
        await highlight(page, focusCard);
        await narrate(page, 'b02 card anatomy', 8);

        // [b03] open the metrics detail panel via the CPU tile
        await clickWithCursor(page, focusCard.getByText('cpu', { exact: true }).first());
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await narrate(page, 'b03 metric panel', 9);

        // [b04] flip to the dense list view
        await clickWithCursor(page, page.getByTestId('view-toggle-list'));
        await expect(page.getByTestId('machine-row').first()).toBeVisible();
        await narrate(page, 'b04 list view', 6);
      },
    );
  } finally {
    await ctx.cleanup();
  }
});
