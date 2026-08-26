/**
 * Scene — episode 11, "distribute project folders with roost". All six beats
 * are SCREEN beats.
 *
 * Rendered VO (voiceover/out/11-distribute-with-roost/, ffprobe):
 *   b01 22.2s what roost is · b02 17.6s new roost · b03 30.4s upload the folder
 *   b04 22.7s targets and distribute · b05 19.6s ship a new version
 *   b06 27.2s roll back
 * b06's outro was revoiced for the v2 series (it now hands off to hoot).
 *
 * Fixture `deploy-roost-rolling`: one roost "stage show", 4 versions, in-flight
 * rollout (3 completed / 1 installing / 6 pending), tier=pro on site-A so the
 * pro-gate clears, admin storageState so publish + rollback are permitted.
 *
 * The "new roost" / "new version" buttons and dialog inputs have no testids —
 * matched by visible text or label.
 *
 * Run:  cd web && npm run videos -- --grep "episode 11"
 * Out:  web/e2e/.output/videos/11-distribute-with-roost.mp4
 */

import { test, expect, type Page } from '@playwright/test';
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

/**
 * Dismiss `ProjectDistributionDialog` through its footer "cancel"
 * (ProjectDistributionDialog.tsx:1222-1229) — NEVER Escape.
 *
 * `RoostsPageClient.tsx:155-179` puts a bubble-phase `window` keydown listener
 * on the page that clears the roost selection on Escape whenever one is
 * selected, and it neither checks `event.defaultPrevented` nor scopes itself to
 * the page: Radix closes the dialog AND the panel disappears with it. Its one
 * skip is an input/textarea/contenteditable target, which is why the b04 close
 * survived (focus was still in `#extract-path`) and the b05 close did not
 * (focus was on the dialog after a button click) — the 2026-08-26 batch failed
 * on exactly that asymmetry, at `#roost-detail-panel` after b05.
 */
async function closeDistributionDialog(page: Page, name: RegExp): Promise<void> {
  // Scoped by accessible name (DialogTitle, ProjectDistributionDialog.tsx
  // :576-580) — a bare getByRole('dialog') is one confirm away from a
  // strict-mode violation. The footer scope keeps "cancel" off the inline
  // preset confirmations, which use the same word.
  const dialog = page.getByRole('dialog', { name });
  await clickWithCursor(
    page,
    dialog
      .locator('[data-slot="dialog-footer"]')
      .getByRole('button', { name: 'cancel', exact: true }),
  );
  await expect(dialog).toBeHidden();
  await page.waitForTimeout(600);
}

test('episode 11 — distribute project folders with roost', async ({ browser }) => {
  const ctx = await seedScreenshotFixtures('deploy-roost-rolling');
  try {
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    await recordScene(
      browser,
      '11-distribute-with-roost',
      { baseURL: E2E_BASE_URL, storageState: roleState('admin').storageState },
      async (page) => {
        // `?roost=` is URL-backed state read by `useSelectedRoost`
        // (RoostsPageClient.tsx:88), so the deep link alone opens the panel —
        // clicking the row on top of that TOGGLES THE SELECTION OFF and the
        // detail panel animates away before b01 starts. Land on the link and
        // wait for the panel, nothing more.
        await openForCapture(page, '/roosts?roost=stage-show');
        await expect(page.locator('#roost-detail-panel')).toBeVisible();
        await expect(page.getByTestId('roost-version-row').first()).toBeVisible();

        // [b01] what roost is (~22.2s). Row first, then panel, so the eye reads
        // "destination + its versions".
        const stageRow = page.locator('[data-roost-row="stage-show"]');
        const detailPanel = page.locator('#roost-detail-panel');
        await centerInView(page, stageRow);
        await highlight(page, stageRow, 2600);
        await narrate(page, 'b01 roost list', 10);
        await centerInView(page, detailPanel);
        await highlight(page, detailPanel, 2600);
        await narrate(page, 'b01 detail panel', 13);

        // [b02] new roost (~17.6s) — opens ProjectDistributionDialog; hover the
        // source toggle so both halves (upload files / by url) read.
        const newRoostButton = page.getByRole('button', { name: 'new roost', exact: true });
        await clickWithCursor(page, newRoostButton);
        await page.waitForTimeout(700);
        const nameInput = page.locator('#distribution-name');
        await typewrite(page, nameInput, 'spring exhibit', 60);
        await narrate(page, 'b02 name + description', 9);
        const sourceToggle = page.getByRole('radiogroup', { name: 'source' });
        await centerInView(page, sourceToggle);
        await highlight(page, sourceToggle, 2600);
        await narrate(page, 'b02 upload files vs by url', 9);

        // [b03] upload the folder (~30.4s). A headed Chromium capture can't drop
        // a real folder, so frame the dropzone, then extract-to with its amber
        // allowed-roots warning. The dropzone is targeted by the idle
        // container's role/aria-label — its visible copy is conditional on the
        // `enumerating` state.
        const dropzone = page.getByRole('region', { name: 'folder drop zone' });
        await centerInView(page, dropzone);
        await highlight(page, dropzone, 3000);
        await narrate(page, 'b03 dropzone — fingerprint and dedupe', 14);
        const extractInput = page.locator('#extract-path');
        await centerInView(page, extractInput);
        // A path outside ~/Documents/ makes isLikelyAllowed false, surfacing the
        // amber allowed-roots warning under the field.
        await typewrite(page, extractInput, 'C:\\Owlette\\projects\\spring', 45);
        await page.waitForTimeout(700);
        await highlight(page, extractInput, 2400);
        await narrate(page, 'b03 extract-to + allowed-roots warning', 17);

        // [b04] targets and distribute (~22.7s). No real folder was dropped, so
        // "upload and distribute" is framed, not clicked.
        const targetsLabel = page.getByText('target machines', { exact: false }).first();
        await centerInView(page, targetsLabel);
        await highlight(page, targetsLabel, 2600);
        await narrate(page, 'b04 targets list', 12);
        const distributeButton = page.getByRole('button', { name: /upload and distribute/i });
        await centerInView(page, distributeButton);
        await highlight(page, distributeButton, 2600);
        await narrate(page, 'b04 per-target status + rollup pill', 12);

        // Close the dialog and head back to the roost detail panel for b05.
        await closeDistributionDialog(page, /^new roost$/i);
        await expect(page.locator('#roost-detail-panel')).toBeVisible();

        // [b05] ship a new version (~19.6s) — "+ new version" in the
        // VersionHistory header reopens the dialog with name/path/targets locked.
        const newVersionButton = page.getByRole('button', { name: 'new version', exact: true });
        await centerInView(page, newVersionButton);
        await clickWithCursor(page, newVersionButton);
        await page.waitForTimeout(900);
        const dialogTitle = page.getByText('publish new version', { exact: false });
        await centerInView(page, dialogTitle);
        await highlight(page, dialogTitle, 2600);
        await narrate(page, 'b05 new version dialog', 10);
        const lockedTargets = page.getByText('target machines', { exact: false }).first();
        await centerInView(page, lockedTargets);
        await highlight(page, lockedTargets, 2600);
        await narrate(page, 'b05 destination and machine list are locked', 10);

        // Close and return to the detail panel for the rollback beat.
        await closeDistributionDialog(page, /publish new version of/i);
        await expect(page.locator('#roost-detail-panel')).toBeVisible();

        // [b06] roll back (~27.2s) — the per-row menu carries edit description,
        // rollback, copy version id, view files, and diff against current. The
        // beat's last line hands off to hoot.
        const versionRows = page.getByTestId('roost-version-row');
        // Sorted newest-first: index 0 is current, index 1 is the version we can
        // roll back to.
        const previousRow = versionRows.nth(1);
        await centerInView(page, previousRow);
        await highlight(page, previousRow, 2800);
        await narrate(page, 'b06 version history', 9);
        const rowMenuTrigger = previousRow.getByRole('button', { name: 'version actions' });
        await clickWithCursor(page, rowMenuTrigger);
        await page.waitForTimeout(600);
        await narrate(page, 'b06 row menu — diff, files, rollback', 9);
        const rollbackItem = page.getByRole('menuitem', {
          name: 'rollback to this version',
          exact: true,
        });
        await centerInView(page, rollbackItem);
        await highlight(page, rollbackItem, 2800);
        await narrate(page, 'b06 rollback + hand-off to hoot', 10);
      },
    );
  } finally {
    await ctx.cleanup();
  }
});
