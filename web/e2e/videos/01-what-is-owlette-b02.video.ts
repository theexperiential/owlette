/**
 * Scene — episode 1, beat b02 ("what owlette is").
 *
 * Script direction: "owlette wordmark; then cut to the dashboard fleet view
 * loading."
 *
 *   - the wordmark is a TITLE CARD (dev/video-tutorials/titles/), built from the
 *     app's own tokens: the real eye SVG, the real Geist face, the .dark palette,
 *     the hero's glow and eye-ignite. It carries the tagline "keeps your
 *     installations running 24/7" — the exact promise b01 now inverts ("your
 *     installation isn't running"), so the cold open is answered one beat later.
 *
 *     Why not shoot the landing hero, which already IS that lockup over that
 *     line: its fixed header carries a "pricing" nav item and the hero carries
 *     "free during beta". This series mentions neither, and a beta claim would
 *     date every copy of the video the day beta ends. Hiding them in CSS was the
 *     other option and is worse — it would put a product state on screen that
 *     does not exist.
 *   - the fleet is the same seeded 10-machine dashboard the rest of the episode
 *     uses, caught while it paints.
 *
 * Its own take rather than a fifth beat inside `01-what-is-owlette.video.ts`:
 * that scene opens authenticated on /dashboard and never leaves it, and a beat
 * is cut from ONE continuous range of ONE file, so b02 needs an unbroken
 * landing→dashboard run of its own. The conform merges takes by beat id, so
 * beats do not have to live in one file or be shot in script order.
 *
 * Rendered VO: b02 21.473s (assembly/manifests/01-what-is-owlette.json), so
 * narrate()'s enforcement holds this take to >= 22.22s of picture.
 *
 * The card must be the take's FIRST navigation: `openForCapture` installs a
 * persistent animation-kill init script that applies to every later document,
 * file:// included, and would flatten the card's reveal to its end state with
 * no error. `openTitleCard` throws rather than let that happen quietly.
 *
 * Run:  cd web && npm run videos -- --grep "episode 1 — b02"
 * Out:  dev/video-tutorials/footage/web/01-what-is-owlette-b02.mp4
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { getAdminDb, E2E_BASE_URL } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import { seedScreenshotFixtures } from '../screenshots/fixtures';
import {
  recordScene,
  openForCapture,
  openTitleCard,
  narrate,
  slowPush,
  slowScrollToBottom,
} from './video-helpers';

/** The brand card, rendered from the app's own tokens. See the file's header. */
const TITLE_CARD = pathToFileURL(
  path.resolve(__dirname, '../../../dev/video-tutorials/titles/01-b02-wordmark.html'),
).href;

test('episode 1 — b02: the wordmark, then the fleet', async ({ browser }) => {
  const ctx = await seedScreenshotFixtures('dashboard-mixed-states');
  try {
    const db = getAdminDb();
    // Auto-select the seeded site, so the cut to /dashboard lands on the fleet
    // rather than on the baseline site's empty state.
    await db
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    await recordScene(
      browser,
      '01-what-is-owlette-b02',
      { baseURL: E2E_BASE_URL, storageState: roleState('admin').storageState },
      async (page) => {
        // [b02] the wordmark (~21.5s of VO across both halves).
        //
        // MUST be the take's first navigation — openTitleCard throws otherwise,
        // because openForCapture's animation kill is an init script that would
        // silently flatten the card's reveal to its end state.
        await openTitleCard(page, TITLE_CARD);
        await expect(page.locator('.wordmark')).toHaveText('owlette');
        // The promise b01 just inverted, set under the mark.
        await expect(page.locator('.tagline')).toHaveText(
          'keeps your installations running 24/7',
        );
        await narrate(page, 'b02 the wordmark and the promise', 1.5);
        // Slow settle into the wordmark; the navigation to /dashboard resets
        // the transform, so the move needs no explicit ease-back here.
        await slowPush(page, { scale: 1.05, originXPct: 50, originYPct: 42, seconds: 4.0 });
        await narrate(page, 'b02 wordmark hold', 3.5);

        // "then cut to the dashboard fleet view loading" — a cut, per the
        // direction, not a click through the header. openForCapture navigates
        // and settles; ffmpeg is running throughout, so the paint is captured.
        await openForCapture(page, '/dashboard');
        await expect(page.getByTestId('machine-card')).toHaveCount(10);
        await narrate(page, 'b02 the fleet lands', 6);

        // A slow drift down the fleet so the beat's tail is motion rather than a
        // static hold — the editor can cut anywhere in it.
        await slowScrollToBottom(page, 8);
      },
    );
  } finally {
    await ctx.cleanup();
  }
});
