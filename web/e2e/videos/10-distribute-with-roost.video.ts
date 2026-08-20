/**
 * Scene — episode 10, "distribute project folders with roost". All six beats
 * are SCREEN beats. VO durations (voiceover/out/10-distribute-with-roost/):
 * b01 22.2s, b02 17.6s, b03 30.4s, b04 22.7s, b05 19.6s, b06 29.2s.
 *
 * Fixture `deploy-roost-rolling`: one roost "stage show", 4 versions, in-flight
 * rollout (3 completed / 1 installing / 6 pending), tier=pro on site-A so the
 * pro-gate clears, admin storageState so publish + rollback are permitted.
 *
 * The "new roost" / "new version" buttons and dialog inputs have no testids —
 * matched by visible text or label.
 *
 * Run:  cd web && npm run videos -- --grep "episode 10"
 * Out:  web/e2e/.output/videos/10-distribute-with-roost.mp4
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
  centerInView,
  clickWithCursor,
  typewrite,
} from './video-helpers';

test('episode 10 — distribute project folders with roost', async ({ browser }) => {
  const ctx = await seedScreenshotFixtures('deploy-roost-rolling');
  try {
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    await recordScene(
      browser,
      '10-distribute-with-roost',
      { baseURL: E2E_BASE_URL, storageState: roleState('admin').storageState },
      async (page) => {
        // Pre-select stage-show so #roost-detail-panel is in frame from b01.
        await openForCapture(page, '/roosts?roost=stage-show');
        const stageRowEl = page.locator('[data-roost-row="stage-show"]');
        await expect(stageRowEl).toBeVisible();
        // `?roost=` doesn't drive `useSelectedRoost` on Playwright's first
        // commit (RoostsPageClient.tsx:96-98), so click the row instead.
        // force:true — tooltip-wrapped chips in the row intercept the click.
        await stageRowEl.click({ force: true });
        await expect(page.locator('#roost-detail-panel')).toBeVisible();
        await expect(page.getByTestId('roost-version-row').first()).toBeVisible();

        // [b01] what roost is. Row first, then panel, so the eye reads
        // "destination + its versions".
        const stageRow = page.locator('[data-roost-row="stage-show"]');
        const detailPanel = page.locator('#roost-detail-panel');
        await centerInView(page, stageRow);
        await highlight(page, stageRow, 2600);
        await narrate(page, 'b01 roost list', 10);
        await centerInView(page, detailPanel);
        await highlight(page, detailPanel, 2600);
        await narrate(page, 'b01 detail panel', 12);

        // [b02] new roost — opens ProjectDistributionDialog; hover the source
        // toggle so both halves (upload files / by url) read.
        const newRoostButton = page.getByRole('button', { name: 'new roost', exact: true }); // VERIFY: top-right Button with text "new roost" (lowercase)
        await clickWithCursor(page, newRoostButton);
        await page.waitForTimeout(700);
        const nameInput = page.locator('#distribution-name'); // VERIFY: Input id="distribution-name" in ProjectDistributionDialog
        await typewrite(page, nameInput, 'spring exhibit', 65);
        await narrate(page, 'b02 name + description', 9);
        const sourceToggle = page.getByRole('radiogroup', { name: 'source' }); // VERIFY: <div role="radiogroup" aria-label="source"> for the upload/url toggle
        await centerInView(page, sourceToggle);
        await highlight(page, sourceToggle, 2600);
        await narrate(page, 'b02 source toggle', 9);

        // [b03] upload the folder. A headed Chromium kiosk capture can't drop a
        // real folder, so we frame the dropzone (~13s) then extract-to with its
        // amber allowed-roots warning (~17s). Targeted by the idle container's
        // role="region" / aria-label="folder drop zone" — the visible copy is
        // conditional on the `enumerating` state.
        const dropzone = page.getByRole('region', { name: 'folder drop zone' });
        await centerInView(page, dropzone);
        await highlight(page, dropzone, 3000);
        await narrate(page, 'b03 dropzone', 13);
        const extractInput = page.locator('#extract-path'); // VERIFY: Input id="extract-path" in ProjectDistributionDialog
        await centerInView(page, extractInput);
        // A path outside ~/Documents/ makes isLikelyAllowed false, surfacing the
        // amber allowed-roots warning under the field.
        await typewrite(page, extractInput, 'C:\\Owlette\\projects\\spring', 50);
        await page.waitForTimeout(700);
        await highlight(page, extractInput, 2400);
        await narrate(page, 'b03 extract-to + warning', 17);

        // [b04] targets and distribute. No real folder was dropped, so the
        // "upload and distribute" button is framed, not clicked.
        const targetsLabel = page.getByText('target machines', { exact: false }).first(); // VERIFY: <Label> reads "target machines (N selected)" — partial-text match
        await centerInView(page, targetsLabel);
        await highlight(page, targetsLabel, 2600);
        await narrate(page, 'b04 targets list', 12);
        const distributeButton = page.getByRole('button', { name: /upload and distribute/i }); // VERIFY: button text is "upload and distribute to N machine(s)" — regex match
        await centerInView(page, distributeButton);
        await highlight(page, distributeButton, 2600);
        await narrate(page, 'b04 distribute button', 11);

        // Close the dialog and head back to the roost detail panel for b05.
        await page.keyboard.press('Escape');
        await page.waitForTimeout(600);
        await expect(page.locator('#roost-detail-panel')).toBeVisible();

        // [b05] ship a new version — "+ new version" in the VersionHistory
        // header reopens the dialog with name/path/targets locked.
        const newVersionButton = page.getByRole('button', { name: 'new version', exact: true }); // VERIFY: VersionHistory <Button> text "new version"
        await centerInView(page, newVersionButton);
        await clickWithCursor(page, newVersionButton);
        await page.waitForTimeout(900);
        // Highlight the locked name + targets so the eye reads "destination is
        // fixed; just drop a new build".
        const dialogTitle = page.getByText('publish new version', { exact: false }); // VERIFY: DialogTitle includes the literal "publish new version of"
        await centerInView(page, dialogTitle);
        await highlight(page, dialogTitle, 2600);
        await narrate(page, 'b05 new version dialog', 10);
        const lockedTargets = page.getByText('target machines', { exact: false }).first();
        await centerInView(page, lockedTargets);
        await highlight(page, lockedTargets, 2600);
        await narrate(page, 'b05 locked targets', 10);

        // Close and return to the detail panel for the rollback beat.
        await page.keyboard.press('Escape');
        await page.waitForTimeout(600);
        await expect(page.locator('#roost-detail-panel')).toBeVisible();

        // [b06] roll back — open the per-row MoreVertical dropdown to surface
        // the rollback / diff / view-files actions.
        const versionRows = page.getByTestId('roost-version-row');
        const previousRow = versionRows.nth(1); // current is index 0 (sorted newest-first); index 1 is the previous version we can roll back to
        await centerInView(page, previousRow);
        await highlight(page, previousRow, 2800);
        await narrate(page, 'b06 version history', 10);
        const rowMenuTrigger = previousRow.getByRole('button', { name: 'version actions' }); // VERIFY: VersionRow MoreVertical button has aria-label="version actions"
        await clickWithCursor(page, rowMenuTrigger);
        await page.waitForTimeout(600);
        await narrate(page, 'b06 row menu open', 9);
        const rollbackItem = page.getByRole('menuitem', { name: 'rollback to this version', exact: true }); // VERIFY: DropdownMenuItem text reads "rollback to this version"
        await centerInView(page, rollbackItem);
        await highlight(page, rollbackItem, 2800);
        await narrate(page, 'b06 rollback item', 10);
      },
    );
  } finally {
    await ctx.cleanup();
  }
});
