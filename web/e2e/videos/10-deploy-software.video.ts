/**
 * Scene — episode 9, "deploy software to many machines". All screen capture,
 * no b-roll. Beats b01–b07 with VO durations
 * (voiceover/out/10-deploy-software/, ffprobe):
 *   b01 the use case                    ~16.6s  deployments list, mixed statuses
 *   b02 new deployment + templates      ~19.1s  open dialog, open template select
 *   b03 installer url + silent flags    ~24.3s  type url, type flags
 *   b04 the options that save you grief ~28.8s  parallel + close-processes
 *   b05 choose your targets             ~14.9s  online-only / select-all / per-row
 *   b06 deploy and watch                ~23.0s  expand in-flight, per-target state
 *   b07 retry the stragglers            ~23.0s  failed row → menu → "retry failed"
 *
 * PRODUCT-BLOCKED (b06): the agent rejects deployments with no sha256 checksum
 * and the dialog has no checksum field, so we never click deploy — it would
 * put a validation toast on camera. Instead we expand the seeded
 * `depl-stage-show-v4` row so the progress board matches the VO. Swap to a
 * real deploy once the gap closes.
 *
 * Fixture: `deploy-roost-rolling` (10 machines, 4 deployments across statuses)
 * plus the admin role storageState.
 *
 * Run:  cd web && npm run videos -- --grep "episode 9"
 * Out:  web/e2e/.output/videos/10-deploy-software.mp4
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
  clickWithCursor,
  typewrite,
  centerInView,
} from './video-helpers';

test('episode 9 — deploy software to many machines', async ({ browser }) => {
  const ctx = await seedScreenshotFixtures('deploy-roost-rolling');
  try {
    // Auto-select the seeded site (admin is also on the baseline site-A).
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    await recordScene(
      browser,
      '10-deploy-software',
      { baseURL: E2E_BASE_URL, storageState: roleState('admin').storageState },
      async (page) => {
        await openForCapture(page, '/deployments');

        // [b01] settle on the deployments list — 4 seeded rows across statuses.
        const inFlightRow = page.getByText('stage show v4', { exact: false }).first();
        await expect(inFlightRow).toBeVisible();
        await narrate(page, 'b01 use case — settle', 17);

        // [b02] new deployment + templates (~19.1s VO).
        const newDeploymentBtn = page.getByRole('button', { name: /new deployment/i }).first();
        await clickWithCursor(page, newDeploymentBtn);
        const dialog = page.getByRole('dialog', { name: /deploy software/i });
        await expect(dialog).toBeVisible();

        const templateTrigger = dialog.getByRole('combobox').first(); // VERIFY — first combobox = template select
        await clickWithCursor(page, templateTrigger);
        await narrate(page, 'b02 template dropdown', 13);
        // Close it so the rest of the dialog is visible for the next beats.
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        await narrate(page, 'b02 close + reset', 6);

        // [b03] installer url + silent flags (~24.3s VO).
        const installerUrlInput = dialog.locator('#installer-url');
        await typewrite(
          page,
          installerUrlInput,
          'https://downloads.derivative.ca/TouchDesigner.2024.40000.exe',
          45,
        );
        await narrate(page, 'b03 url typed — filename derives', 6);

        const silentFlagsInput = dialog.locator('#silent-flags');
        await typewrite(page, silentFlagsInput, '/VERYSILENT /NORESTART', 45);
        await narrate(page, 'b03 silent flags typed', 8);

        // [b04] the options that save you grief (~28.8s VO).
        const parallelCheckbox = dialog.locator('#parallel-install');
        await centerInView(page, parallelCheckbox);
        await highlight(page, parallelCheckbox, 1600);
        await narrate(page, 'b04 parallel install option', 8);

        const closeProcessesToggle = dialog.getByRole('button', {
          name: /close running processes before install/i,
        });
        await clickWithCursor(page, closeProcessesToggle);
        await page.waitForTimeout(400);
        // A process name is needed to put the amber warning banner on camera.
        const additionalProcesses = dialog.locator('#additional-processes');
        await typewrite(page, additionalProcesses, 'TouchDesigner.exe', 50);
        await narrate(page, 'b04 close-processes + warning', 12);

        // [b05] choose your targets (~14.9s VO).
        const onlineOnlyBtn = dialog.getByRole('button', { name: /^online only/i });
        await centerInView(page, onlineOnlyBtn);
        await clickWithCursor(page, onlineOnlyBtn);
        await narrate(page, 'b05 online only clicked', 7);

        // The toggle-all label flips between "select all" and "deselect all".
        // All 10 seeded machines are online, so after "online only" it reads
        // "deselect all"; match either so a mixed-fleet seed can't break this.
        const toggleAllBtn = dialog.getByRole('button', { name: /^(?:de)?select all$/i });
        await clickWithCursor(page, toggleAllBtn);
        await narrate(page, 'b05 select-all toggle clicked', 8);

        // Close the dialog without submitting — see JSDoc note on b06.
        const cancelBtn = dialog.getByRole('button', { name: /^cancel$/i }).first();
        await clickWithCursor(page, cancelBtn);
        await expect(dialog).not.toBeVisible();

        // [b06] expand the seeded in-flight row: 3 done, 1 installing 64%, 6 pending.
        await centerInView(page, inFlightRow);
        await clickWithCursor(page, inFlightRow);
        await expect(
          page.getByText('media-server-stage', { exact: false }).first(),
        ).toBeVisible();
        await narrate(page, 'b06 in-flight progress board', 23);
        // Collapse before moving to the failed row.
        await clickWithCursor(page, inFlightRow);
        await page.waitForTimeout(300);

        // [b07] retry the stragglers (~23.0s VO).
        const failedRow = page
          .getByText('touchdesigner 2024.40000 driver bump', { exact: false })
          .first();
        await centerInView(page, failedRow);
        await highlight(page, failedRow, 1800);

        const failedRowActions = page.getByRole('button', {
          name: /deployment actions for touchdesigner 2024\.40000 driver bump/i,
        }); // VERIFY — aria-label format from DeploymentRow MoreVertical button
        await clickWithCursor(page, failedRowActions);
        const retryItem = page.getByRole('menuitem', { name: /retry failed/i });
        await expect(retryItem).toBeVisible();
        await highlight(page, retryItem, 1800);
        await narrate(page, 'b07 retry failed menu', 23);
      },
    );
  } finally {
    await ctx.cleanup();
  }
});
