/**
 * Screenshot — diagnose capability card preview (api-sprint wave 4.3).
 *
 * Output: `web/public/landing-screens/preview-diagnose.png`
 * Used by: the landing page diagnose capability card (wired up by wave 4.5).
 *
 * Drives the cortex chat into the `diagnose-cortex-chat` scenario: a seeded
 * conversation against `media-server-stage` showing a realistic incident
 * Q&A (crash diagnosis + recurrence prediction). The fixture also seeds the
 * user's LLM key bypass so the cortex page renders the chat surface
 * instead of the no-key gate.
 *
 * Cortex's page doesn't accept a conversation id via URL params, so we
 * click the seeded conversation in the sidebar to open it (its title is
 * deterministic — "03:14 incident — media-server-stage").
 */
import { test, expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { getAdminDb } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import { FIXED_NOW_MS, seedScreenshotFixtures } from './fixtures';

test.use(roleState('admin'));

test('diagnose capability card preview', async ({ page }) => {
  const ctx = await seedScreenshotFixtures('diagnose-cortex-chat');

  try {
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    // Pin the clock BEFORE goto so the chat sidebar's relative "x ago"
    // timestamps render deterministically.
    await page.clock.install({ time: FIXED_NOW_MS });

    await page.goto('/cortex');

    // Find the seeded conversation in the sidebar and click it to load
    // its persisted message history into the chat window.
    const conversationItem = page
      .getByText('03:14 incident — media-server-stage', { exact: false })
      .first();
    await expect(conversationItem).toBeVisible();
    await conversationItem.click();

    // Confirm the assistant's first reply rendered (the persisted message
    // load is async — we want to capture pixels only after the chat body
    // has the seeded Q&A).
    await expect(
      page.getByText('access violation', { exact: false })
    ).toBeVisible();

    // dashboard has persistent firestore websockets — network never idles. wait for paint instead.
    await page.waitForTimeout(1500);

    await page.addStyleTag({
      content: `
        *, *::before, *::after {
          animation-duration: 0s !important;
          animation-delay: 0s !important;
          transition-duration: 0s !important;
          transition-delay: 0s !important;
        }
      `,
    });

    await page.clock.setFixedTime(FIXED_NOW_MS);

    // Markdown-rendered messages mount a frame after the chat doc resolves;
    // give them a beat before screenshotting.
    await page.waitForTimeout(500);

    await page.screenshot({
      path: 'public/landing-screens/preview-diagnose.png',
      fullPage: false,
    });
  } finally {
    await ctx.cleanup();
  }
});
