/**
 * Scene — episode 3, "install owlette & pair your first machine": the PAIRING
 * DIALOG segment only.
 * Script: dev/video-tutorials/scripts/03-install-and-pair.md (FINAL).
 *
 * Episode 3 is three surfaces stitched together, and this file owns exactly one
 * of them. The installer wizard (b01, b03, b04) is a Delphi `TWizardForm` and
 * stays with pywinauto in `dev/video-tutorials/capture-native`. The dashboard
 * and the /add page (b02, b06's browser half, b07, b08, b09) are the web
 * pipeline's. What is left — everything inside the owlette window — is here,
 * because since 3.0.0 the installer no longer blocks on a pairing console: it
 * calls `ExecAsOriginalUser(owlette-desktop.exe, '--pair --server …', ewNoWait)`
 * and returns (agent/owlette_installer.iss:841-857). So the pairing phrase the
 * episode is about is drawn by a WebView2, and CDP is the way to it.
 *
 * The take launches the app with the installer's own argv — `--pair --server
 * prod`, which arms `useLaunchFlag(ARG_PAIR)` and opens the join dialog at
 * startup, exactly as an interactive install does. `configure_site.py` in the
 * scratch tree is the video stub (`./fixtures.ts`), so the phrase on camera is
 * always `silver-compass-drift` and no real device code is ever burned. Nothing
 * authorizes: an approval would need a real code, and b08's "paired" line is a
 * two-shot the editor builds from the dashboard side.
 *
 * VO durations, ffprobe of dev/video-tutorials/voiceover/out/03-install-and-pair/
 * (rounded up ~0.5s per beat):
 *
 *   beat  mp3      budget   this take   other surface
 *   b05   15.07s   15.6s    15.6        —
 *   b06   23.56s   24.1s    10.0        14.1  owlette.app/add in a browser (web)
 *   b10   21.16s   21.7s    16.7        5.0   start menu → Owlette (native)
 *
 * The b05 direction asks for a zoom onto the phrase. The capture region is fixed
 * for a take (ddagrab films one rectangle), so the punch-in is an edit-time
 * move; what this take gives the editor is a held, highlighted phrase at native
 * resolution to punch into.
 *
 * b06's "open owlette.app/add" button is glided to and NOT clicked. Clicking it
 * asks the host to open the operator's default browser, which would take the
 * shot off the app and land on a page the web pipeline films deterministically.
 *
 * Run:  cd web && npm run videos:desktop -- --grep "episode 3"
 * Out:  web/e2e/.output/desktop-videos/03-install-and-pair-desktop.mp4
 */

import { expect, test } from '@playwright/test';
import { SCRATCH_ROOT } from '../desktop-screenshots/harness';
import { DEMO_PAIR_PHRASE, seedVideoScenario } from './fixtures';
import { endTake, recordDesktopScene, startTake, type DesktopTake } from './harness';
import {
  clickWithCursor,
  highlight,
  moveCursorTo,
  narrate,
  parkPointer,
  settle,
} from './video-helpers';

test.describe.configure({ mode: 'serial' });

let take: DesktopTake | null = null;

test.afterEach(async () => {
  await endTake(take);
  take = null;
});

test('episode 3 — install and pair, the pairing dialog', async () => {
  // A machine mid-install: the agent is on disk, nothing is paired, nothing is
  // configured to run — so the empty sidebar behind the modal is honest.
  seedVideoScenario(SCRATCH_ROOT, 'fresh');
  take = await startTake(['--pair', '--server', 'prod']);

  const app = take.page;
  const dialog = app.getByTestId('join-site-dialog');
  await expect(dialog).toBeVisible();
  // The phrase arrives on the stub's second line; hold until it has.
  await expect(app.getByTestId('join-phrase')).toContainText(DEMO_PAIR_PHRASE);
  await expect(app.getByTestId('join-status')).toHaveText('waiting for authorization');
  await parkPointer(app);
  await settle(app);

  await recordDesktopScene(take, '03-install-and-pair-desktop', async (page) => {
    // [b05] the pairing phrase — 15.6s, all here.
    await narrate(page, 'b05 the pairing window is already open', 5);

    await highlight(page, page.getByTestId('join-phrase'), 2600);
    await narrate(page, 'b05 three simple words (punch in here)', 5);

    await highlight(page, page.getByTestId('join-status'), 2000);
    await narrate(page, 'b05 waiting for authorization — expires in ten minutes', 5.6);

    // [b06] opening the pairing page — 10.0s of 24.1s. The dialog names the host
    // it will authorize against; the /add page says the same thing under its
    // title, and that half is the web pipeline's shot.
    // The description is one <p>; `getByText` would also match its ancestors.
    await highlight(page, dialog.locator('p', { hasText: 'approve this machine at' }), 2200);
    await narrate(page, 'b06 the host it authorizes against', 5);

    // Glide only — clicking opens a real browser (see the header note).
    await moveCursorTo(page, dialog.getByRole('button', { name: /^open .*\/add$/ }));
    await narrate(page, 'b06 the button that opens the add page for you', 5);

    // [b10] if pairing doesn't go through — 16.7s of 21.7s. The start-menu
    // relaunch is the native segment; this is what happens once the window is
    // back: the menu hands out a fresh phrase, with nothing to reinstall.
    await clickWithCursor(page, dialog.getByRole('button', { name: 'cancel' }));
    await expect(dialog).toBeHidden();
    await parkPointer(page);
    await narrate(page, 'b10 closed while it was still waiting', 5);

    await clickWithCursor(page, page.getByTestId('app-menu-trigger'));
    await clickWithCursor(page, page.getByTestId('menu-join-site'));
    await expect(dialog).toBeVisible();
    await narrate(page, 'b10 menu → join site', 6);

    await expect(page.getByTestId('join-phrase')).toContainText(DEMO_PAIR_PHRASE);
    await highlight(page, page.getByTestId('join-phrase'), 2200);
    await narrate(page, 'b10 a fresh phrase, nothing to reinstall', 5.7);
  });
});
