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
 * Out:  dev/video-tutorials/footage/web/11-distribute-with-roost.mp4
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
  slowPush,
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
        await narrate(page, 'b01 detail panel', 3.9);
        await slowPush(page, { scale: 1.04, originXPct: 50, originYPct: 48, seconds: 3.5 });
        await narrate(page, 'b01 detail panel - close', 2.1);
        await slowPush(page, { scale: 1.0, seconds: 2.5 });
        await narrate(page, 'b01 detail panel - settle', 1.0);

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

        // [b03] upload the folder (~31.1s) — a REAL drop, synthesized.
        // A headed capture cannot drag an OS folder, but the dropzone's
        // enumerateDataTransfer falls back to plain `dataTransfer.files` when
        // the folder-entry branch yields nothing — so a DragEvent carrying
        // in-page File objects (and an EMPTY items list, to force that
        // fallback) enumerates for real: dragover lights the zone, drop lands
        // the file list, fingerprint/dedupe copy plays over actual files.
        const dropzone = page.getByRole('region', { name: 'folder drop zone' });
        await centerInView(page, dropzone);
        await highlight(page, dropzone, 2400);
        await narrate(page, 'b03 dropzone framed', 2.6);
        await page.evaluate(() => {
          const zone = document.querySelector('[aria-label="folder drop zone"]');
          if (!zone) throw new Error('dropzone not found');
          const mk = (name: string, size: number) =>
            new File([new Uint8Array(size).fill(65)], name, {
              type: 'application/octet-stream',
            });
          const files = [
            mk('show.toe', 48_000),
            mk('loop-a.mp4', 210_000),
            mk('loop-b.mp4', 190_000),
            mk('settings.json', 2_400),
          ];
          const fire = (type: string): void => {
            const ev = new DragEvent(type, { bubbles: true, cancelable: true });
            Object.defineProperty(ev, 'dataTransfer', {
              value: {
                items: [],
                files,
                types: ['Files'],
                dropEffect: 'copy',
                effectAllowed: 'all',
              },
            });
            zone.dispatchEvent(ev);
          };
          fire('dragenter');
          fire('dragover');
          return new Promise<void>((resolve) =>
            setTimeout(() => {
              fire('drop');
              resolve();
            }, 1200),
          );
        });
        await narrate(page, 'b03 files land — fingerprint and dedupe', 7.2);
        const extractInput = page.locator('#extract-path');
        await centerInView(page, extractInput);
        // A path outside ~/Documents/ makes isLikelyAllowed false, surfacing the
        // amber allowed-roots warning under the field.
        // Real backslashes matter twice over: TS silently ate un-escaped ones
        // once, the on-screen path read "C:Owletteprojectsspring" (rosco), and
        // the publish rejected it — which held the dialog open and killed the
        // take's close-wait.
        await typewrite(page, extractInput, 'C:\\Owlette\\projects\\spring-exhibit', 45);
        await page.waitForTimeout(600);
        await highlight(page, extractInput, 2400);
        await narrate(page, 'b03 extract-to + allowed-roots warning', 5.0);
        await narrate(page, 'b03 extract-to — hold', 9.0);

        // [b04] targets and distribute (~22.5s) — REAL this time: check three
        // machines, click "upload and distribute" (tiny files upload through
        // the actual chunk flow against the emulator), then PLAY THE AGENTS:
        // the dialog closes itself on success, so open the new roost's detail
        // panel and write target_state docs on the narration's measured cues
        // (downloading 7.4s, assembling 8.3s, synced 12.8s, rollup 13.8s).
        const dialog = page.getByRole('dialog', { name: /^new roost$/i });
        const targets = ['media-server-stage', 'td-control-room', 'mainstage-led'];
        for (const m of targets) {
          // Click the ROW, never the Checkbox: the checkbox's onCheckedChange
          // toggles AND the click bubbles to the row's onClick which toggles
          // again - a silent net-zero that shipped a take with "0 selected"
          // (and is a real product bug for users clicking the box directly).
          await clickWithCursor(page, dialog.getByText(m, { exact: true }));
        }
        // Fail HERE, not at the distribute timeout, if selection didn't take.
        await expect(dialog.getByText(/\(3 selected\)/)).toBeVisible();
        await narrate(page, 'b04 targets picked', 0.6);
        const distributeButton = page.getByRole('button', { name: /upload and distribute/i });
        await expect(distributeButton).toBeEnabled();
        await clickWithCursor(page, distributeButton);
        // "upload and distribute" opens the PreUploadSummary gate (size, ETA,
        // per-target free disk) — a deliberate confirm step the first two
        // takes didn't know about; nothing uploads until "start upload".
        const startUpload = page.getByRole('button', { name: 'start upload', exact: true });
        await expect(startUpload).toBeVisible();
        await narrate(page, 'b04 pre-upload summary', 1.2);
        await clickWithCursor(page, startUpload);
        // The dialog closes itself when the upload publishes.
        await expect(dialog).not.toBeVisible({ timeout: 30_000 });
        // Find the roost the flow just created, open its panel.
        const db = getAdminDb();
        let newRoostId = '';
        for (let i = 0; i < 20 && !newRoostId; i++) {
          const snap = await db.collection('sites').doc(ctx.siteId).collection('roosts').get();
          for (const d of snap.docs) {
            if ((d.data().name as string) === 'spring exhibit') newRoostId = d.id;
          }
          if (!newRoostId) await page.waitForTimeout(400);
        }
        if (!newRoostId) throw new Error('spring exhibit roost never appeared');
        // The row derives "synced" only when reportedVersionId matches the
        // roost's CURRENT version — a placeholder id renders every pill as
        // "awaiting agent" (stale), which one take shipped.
        let liveVersionId = '';
        for (let i = 0; i < 20 && !liveVersionId; i++) {
          const doc = await db.collection('sites').doc(ctx.siteId)
            .collection('roosts').doc(newRoostId).get();
          liveVersionId = (doc.data()?.currentVersionId as string) ?? '';
          if (!liveVersionId) await page.waitForTimeout(400);
        }
        if (!liveVersionId) throw new Error('published version id never appeared');
        await clickWithCursor(page, page.getByText('spring exhibit', { exact: true }).first());
        const stateRef = (m: string) =>
          db.collection('sites').doc(ctx.siteId).collection('roosts')
            .doc(newRoostId).collection('target_state').doc(m);
        const writeState = async (m: string, status: string, extra: object = {}) => {
          await stateRef(m).set({ status, updatedAt: new Date(), ...extra }, { merge: true });
        };
        for (const m of targets) await writeState(m, 'pending');
        await narrate(page, 'b04 queued', 0.5);
        await writeState(targets[0], 'downloading', { chunksTotal: 4, chunksFetched: 1 });
        await writeState(targets[1], 'downloading', { chunksTotal: 4, chunksFetched: 0 });
        await narrate(page, 'b04 downloading', 1.0);
        await writeState(targets[0], 'assembling', { filesTotal: 4, filesAssembled: 2 });
        await writeState(targets[2], 'downloading', { chunksTotal: 4, chunksFetched: 2 });
        await narrate(page, 'b04 assembling', 3.6);
        await writeState(targets[0], 'committed', { reportedVersionId: liveVersionId });
        await writeState(targets[1], 'assembling', { filesTotal: 4, filesAssembled: 1 });
        await narrate(page, 'b04 first target synced', 1.4);
        await writeState(targets[1], 'committed', { reportedVersionId: liveVersionId });
        await writeState(targets[2], 'assembling', { filesTotal: 4, filesAssembled: 3 });
        await narrate(page, 'b04 rollup — syncing', 2.4);
        await writeState(targets[2], 'committed', { reportedVersionId: liveVersionId });
        await narrate(page, 'b04 rollup — synced, at a glance', 4.5);

        // The dialog closed itself on publish and b04 opened the new roost's
        // panel - b05 ships v2 of the roost the viewer just watched us create,
        // which is a better story than hopping back to the seeded one.
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
        //
        // Switch back to STAGE SHOW first (b05's tail, off camera): rollback
        // needs a roost with HISTORY, and spring exhibit — selected since b04
        // created it — has exactly one version, which stalled a take waiting
        // for a second row.
        await clickWithCursor(page, page.locator('[data-roost-row="stage-show"]'));
        await expect(page.getByTestId('roost-version-row').nth(1)).toBeVisible();
        await page.waitForTimeout(500);
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
