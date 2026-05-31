/**
 * Scene — episode 10, "distribute project folders with roost".
 *
 * Every beat is a SCREEN beat (no B-ROLL), so all six are captured.
 * Rendered VO durations (voiceover/out/10-distribute-with-roost/):
 *   b01 ≈ 22.2s — what roost is (the roosts list + "stage show" detail panel)
 *   b02 ≈ 17.6s — new roost (open ProjectDistributionDialog, name + source toggle)
 *   b03 ≈ 30.4s — upload the folder (dropzone + extract-to allowlist warning)
 *   b04 ≈ 22.7s — targets and distribute (the target machines checklist + per-target status pills)
 *   b05 ≈ 19.6s — ship a new version (open existing roost, click "+ new version", locked fields)
 *   b06 ≈ 29.2s — roll back (the version-history rows + per-version dropdown)
 *
 * Fixture: `deploy-roost-rolling` (script front matter) — a single roost named
 * "stage show" with 4 versions and an in-flight rollout (3 completed / 1
 * installing / 6 pending). Tier=pro on site-A so the pro-gate clears. Admin is
 * the role storageState (site-admin → can publish + roll back).
 *
 * Selectors:
 *   data-roost-row="stage-show"        — the roost list row (verified via roost.spec.ts)
 *   #roost-detail-panel                — the right-side panel id (verified via roost.spec.ts)
 *   data-testid="roost-version-row"    — every version-history row
 * The "new roost" / "new version" buttons + dialog inputs don't have testids,
 * so they're matched by their visible text or label (marked VERIFY).
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
        // Open the roosts page with the stage-show roost pre-selected, so the
        // right-side detail panel (#roost-detail-panel) is in frame from the
        // first beat. Mirrors roost.spec.ts.
        await openForCapture(page, '/roosts?roost=stage-show');
        const stageRowEl = page.locator('[data-roost-row="stage-show"]');
        await expect(stageRowEl).toBeVisible();
        // The `?roost=stage-show` URL param doesn't drive `useSelectedRoost`
        // (RoostsPageClient.tsx:96-98) on Playwright's first commit, so the
        // detail panel isn't mounted yet — click the row to drive selection
        // through the same path a real user takes. force:true because each
        // row's children include tooltip-wrapped chips that can intercept
        // the click (same intercept class as ep07/ep13).
        await stageRowEl.click({ force: true });
        await expect(page.locator('#roost-detail-panel')).toBeVisible();
        await expect(page.getByTestId('roost-version-row').first()).toBeVisible();

        // [b01] what roost is — frame the roosts list with the stage-show row
        // expanded into the detail panel (~22.2s VO). Highlight the row first,
        // then the panel, so the eye reads "destination + its versions".
        const stageRow = page.locator('[data-roost-row="stage-show"]');
        const detailPanel = page.locator('#roost-detail-panel');
        await centerInView(page, stageRow);
        await highlight(page, stageRow, 2600);
        await narrate(page, 'b01 roost list', 10);
        await centerInView(page, detailPanel);
        await highlight(page, detailPanel, 2600);
        await narrate(page, 'b01 detail panel', 12);

        // [b02] new roost — click the "new roost" button (top-right of the
        // page header), the ProjectDistributionDialog opens. Type a name and
        // hover the source toggle (upload files / by url) so both halves
        // read (~17.6s VO).
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

        // [b03] upload the folder — the FolderDropzone sits below the source
        // toggle when sourceMode='upload' (the default). We can't actually
        // drop a real folder in a headed Chromium kiosk capture, so we frame
        // the dropzone and the "extract to" field with its allowed-roots
        // amber warning (the warning fires when the user types a path
        // outside the default ~/Documents/ root) (~30.4s VO).
        //
        // Split the beat:
        //   ~13s — dropzone in frame (the fingerprinting / dedup pitch)
        //   ~17s — extract-to + amber warning (the allowlist explanation)
        // FolderDropzone's idle container exposes role="region" with
        // aria-label="folder drop zone" (FolderDropzone.tsx:353-354) — a
        // much more reliable target than the visible copy, which reads
        // "drag a folder or files here to upload" (FolderDropzone.tsx:358)
        // and is conditional on the `enumerating` state.
        const dropzone = page.getByRole('region', { name: 'folder drop zone' });
        await centerInView(page, dropzone);
        await highlight(page, dropzone, 3000);
        await narrate(page, 'b03 dropzone', 13);
        const extractInput = page.locator('#extract-path'); // VERIFY: Input id="extract-path" in ProjectDistributionDialog
        await centerInView(page, extractInput);
        // Type a path outside ~/Documents/ so the amber allowed-roots warning
        // surfaces under the field (isLikelyAllowed returns false for any
        // absolute path that isn't under the default Documents root).
        await typewrite(page, extractInput, 'C:\\Owlette\\projects\\spring', 50);
        await page.waitForTimeout(700);
        await highlight(page, extractInput, 2400);
        await narrate(page, 'b03 extract-to + warning', 17);

        // [b04] targets and distribute — the target-machines checklist sits
        // at the bottom of the dialog (10 machines from the seed). Highlight
        // it, then the "upload and distribute" primary button (~22.7s VO).
        // We can't actually submit (no real folder dropped), so we frame the
        // button rather than clicking it.
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

        // [b05] ship a new version — click "+ new version" inside the
        // existing roost's panel (VersionHistory header has the button next
        // to "version history"). The dialog reopens in new-version mode
        // with the name + extract path + targets locked (~19.6s VO).
        const newVersionButton = page.getByRole('button', { name: 'new version', exact: true }); // VERIFY: VersionHistory <Button> text "new version"
        await centerInView(page, newVersionButton);
        await clickWithCursor(page, newVersionButton);
        await page.waitForTimeout(900);
        // The dialog title now reads "publish new version of \"stage show\"".
        // Highlight the locked name field + locked targets section so the
        // eye reads "destination is fixed; just drop a new build".
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

        // [b06] roll back — the version-history rows show every version
        // (current marked by an emerald dot). Open the per-row dropdown
        // (the MoreVertical button) to surface "edit description / rollback
        // to this version / copy version id / view files / diff against
        // current" (~29.2s VO).
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
