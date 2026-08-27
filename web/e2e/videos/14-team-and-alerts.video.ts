/**
 * Scene — episode 14, "team & alerts". Every beat is SCREEN capture.
 *
 * Rendered VO (voiceover/out/14-team-and-alerts/, ffprobe):
 *   b01 18.5s how the team works · b02 20.0s assign a role and sites
 *   b03 33.3s what each role can do · b04 12.4s alerts: let owlette tell you
 *   b05 33.2s build a rule · b06 18.8s your personal alert preferences
 *   b07 28.6s what actually arrives
 * b03 and b06 were revoiced for the v2 series; b03's narration now matches the
 * role-card copy word for word, so the beat frames the cards themselves rather
 * than talking over them.
 *
 * SUPERADMIN throughout: /admin is wrapped in RequireSuperadmin
 * (app/admin/layout.tsx:156).
 *
 * ALERT SCHEMA. /admin/alerts reads `sites/{id}/settings/alerts.rules[]`, seeded
 * inline below the way `screenshots/email-alerts.spec.ts` does. The base
 * scenario also writes `sites/{id}/alertRules/*`, which is DEAD DATA — written
 * only by fixtures.ts and read by nothing. The live automation schema is
 * `sites/{siteId}/talons` (scenario `automate-talons-list`), which is episode 13.
 *
 * b07 IS PART-BLOCKED — see the beat comment for the one-line product change
 * that unblocks the email frame.
 *
 * Run:  cd web && npm run videos -- --grep "episode 14"
 * Out:  dev/video-tutorials/footage/web/14-team-and-alerts.mp4
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
  slowScrollToBottom,
} from './video-helpers';

test('episode 14 — team & alerts', async ({ browser }) => {
  const ctx = await seedScreenshotFixtures('automate-schedule-editor');
  try {
    // Pin the superadmin to the seeded site so per-site selectors find data.
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.superadmin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    // Threshold-rule schema on settings/alerts — what /admin/alerts reads.
    await getAdminDb()
      .collection('sites')
      .doc(ctx.siteId)
      .collection('settings')
      .doc('alerts')
      .set({
        rules: [
          {
            id: 'rule-gpu-overheating',
            name: 'GPU Overheating',
            metric: 'gpu_temp',
            operator: '>',
            value: 85,
            severity: 'warning',
            channels: ['email', 'webhook'],
            enabled: true,
            cooldownMinutes: 30,
          },
          {
            id: 'rule-high-cpu-stage',
            name: 'High CPU on stage machines',
            metric: 'cpu_percent',
            operator: '>',
            value: 95,
            severity: 'critical',
            channels: ['email'],
            enabled: true,
            cooldownMinutes: 15,
          },
          {
            id: 'rule-low-disk',
            name: 'Low Disk',
            metric: 'disk_percent',
            operator: '<',
            value: 10,
            severity: 'warning',
            channels: ['email', 'webhook'],
            enabled: true,
            cooldownMinutes: 60,
          },
        ],
      });

    await recordScene(
      browser,
      '14-team-and-alerts',
      { baseURL: E2E_BASE_URL, storageState: roleState('superadmin').storageState },
      async (page) => {
        // [b01] how the team works (~18.5s) — the user-management list.
        await openForCapture(page, '/admin/users');
        await expect(
          page.getByRole('heading', { name: 'user management', exact: true }),
        ).toBeVisible();
        await expect(page.getByText('admin@e2e.test', { exact: false }).first()).toBeVisible();
        await narrate(page, 'b01 user list — no invite step to chase', 19);

        // [b02] assign a role and sites (~20.0s). Let "reset 2FA…" sit on camera
        // for a beat while the row menu is open — it is the recovery path when a
        // teammate loses their last factor, and episode 2 b09 cuts this frame in.
        const memberRow = page.getByRole('row').filter({ hasText: 'member@e2e.test' });
        // MoreVertical is the last button in the row; it carries no testid.
        const memberActions = memberRow.getByRole('button').last();
        await centerInView(page, memberRow);
        await clickWithCursor(page, memberActions);
        await highlight(page, page.getByRole('menuitem', { name: /reset 2FA/i }), 2200);
        await narrate(page, 'b02 the row menu, reset 2FA included', 5);
        const changeRoleItem = page.getByRole('menuitem', { name: /change role/i });
        await clickWithCursor(page, changeRoleItem);

        const roleDialog = page.getByRole('dialog', { name: /change role/i });
        await expect(roleDialog).toBeVisible();
        const roleSelectTrigger = roleDialog.getByRole('combobox').first();
        await clickWithCursor(page, roleSelectTrigger);
        await page.waitForTimeout(400);
        const adminOption = page.getByRole('option', { name: /^admin$/i }).first();
        await expect(adminOption).toBeVisible();
        await highlight(page, adminOption, 1600);
        await narrate(page, 'b02 role select', 6);
        await clickWithCursor(page, adminOption);
        await narrate(page, 'b02 admin description', 4);
        // Cancel — never mutate the seeded users.
        await clickWithCursor(page, roleDialog.getByRole('button', { name: /^cancel$/i }));
        await expect(roleDialog).not.toBeVisible();
        // "manage sites" is the second of the two controls this beat names.
        await clickWithCursor(page, memberActions);
        await highlight(page, page.getByRole('menuitem', { name: /manage sites/i }), 2200);
        await narrate(page, 'b02 and their sites', 5);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);

        // [b03] what each role can do (~33.3s). The card copy and the narration
        // now say the same thing, so each card is framed while its role is
        // named — no paraphrase to talk over.
        await slowScrollToBottom(page, 6);
        const memberRoleCard = page
          .locator('div')
          .filter({ hasText: /read-only access to assigned sites/i })
          .last();
        await centerInView(page, memberRoleCard);
        await highlight(page, memberRoleCard, 2600);
        await narrate(page, 'b03 member — read-only, own alert prefs', 10);
        const adminRoleCard = page
          .locator('div')
          .filter({ hasText: /site-scoped elevated tier/i })
          .last();
        await centerInView(page, adminRoleCard);
        await highlight(page, adminRoleCard, 2600);
        await narrate(page, 'b03 admin — commands, talons, deployments, members', 14);
        const superadminRoleCard = page
          .locator('div')
          .filter({ hasText: /platform-wide god-mode/i })
          .last();
        await centerInView(page, superadminRoleCard);
        await highlight(page, superadminRoleCard, 2600);
        await narrate(page, 'b03 superadmin — users and installers', 10);

        // [b04] alerts: let owlette tell you (~12.4s).
        await openForCapture(page, '/admin/alerts');
        await expect(
          page.getByRole('heading', { name: 'alerts', exact: true }),
        ).toBeVisible();
        await expect(page.getByText('GPU Overheating', { exact: false })).toBeVisible();
        await narrate(page, 'b04 per-site rules list', 13);

        // [b05] build a rule (~33.2s).
        const createRuleBtn = page.getByRole('button', { name: /create rule/i }).first();
        await clickWithCursor(page, createRuleBtn);
        const ruleDialog = page.getByRole('dialog', { name: /create alert rule/i });
        await expect(ruleDialog).toBeVisible();

        await typewrite(page, ruleDialog.locator('#rule-name'), 'GPU overheat', 45);

        // Selects, in DOM order: metric, operator, severity.
        const metricTrigger = ruleDialog.getByRole('combobox').nth(0);
        await clickWithCursor(page, metricTrigger);
        await page.waitForTimeout(300);
        await clickWithCursor(page, page.getByRole('option', { name: /GPU temperature/i }));
        await narrate(page, 'b05 metric', 6);

        const operatorTrigger = ruleDialog.getByRole('combobox').nth(1);
        await clickWithCursor(page, operatorTrigger);
        await page.waitForTimeout(300);
        await clickWithCursor(page, page.getByRole('option', { name: '>', exact: true }));
        await typewrite(page, ruleDialog.locator('#rule-value'), '85', 60);
        await narrate(page, 'b05 operator and value', 6);

        // Warning is already the default; opened only to show the options.
        const severityTrigger = ruleDialog.getByRole('combobox').nth(2);
        await clickWithCursor(page, severityTrigger);
        await page.waitForTimeout(300);
        const warningOption = page.getByRole('option', { name: /^warning$/i });
        await highlight(page, warningOption, 1400);
        await clickWithCursor(page, warningOption);
        await narrate(page, 'b05 severity, channels, cooldown', 10);

        await clickWithCursor(page, ruleDialog.getByRole('button', { name: /^cancel$/i }));
        await expect(ruleDialog).not.toBeVisible();
        const presetsBtn = page.getByRole('button', { name: /^presets$/i }).first();
        await clickWithCursor(page, presetsBtn);
        const firstPreset = page.getByRole('menuitem', { name: /GPU Overheating/i }).first();
        await expect(firstPreset).toBeVisible();
        await highlight(page, firstPreset, 2000);
        await narrate(page, 'b05 four ready-made templates', 11);
        // Dismiss without applying — it would add a duplicate rule.
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);

        // [b06] your personal alert preferences (~18.8s). The admin layout
        // renders no PageHeader, so `user-menu-trigger` does not exist there —
        // go back to the dashboard before opening the avatar menu.
        await openForCapture(page, '/dashboard');
        await clickWithCursor(page, page.getByTestId('user-menu-trigger'));
        const accountSettingsItem = page.getByRole('menuitem', { name: /account settings/i });
        await expect(accountSettingsItem).toBeVisible();
        await clickWithCursor(page, accountSettingsItem);

        // The settings dialog has a VisuallyHidden DialogTitle, so it has no
        // accessible name — scope by the tab list it is the only holder of
        // rather than matching every dialog on the page.
        const settingsDialog = page.getByRole('dialog').filter({
          has: page.getByRole('button', { name: /^alerts$/i }),
        });
        await expect(settingsDialog).toBeVisible();
        await clickWithCursor(page, settingsDialog.getByRole('button', { name: /^alerts$/i }).first());
        await expect(
          settingsDialog.getByText('machine offline alerts', { exact: false }),
        ).toBeVisible();
        await narrate(page, 'b06 the six category toggles', 10);

        const alertEmailSection = settingsDialog.getByText('alert email', { exact: true }).first();
        await centerInView(page, alertEmailSection);
        await highlight(page, alertEmailSection, 1800);
        await narrate(page, 'b06 alert email + up to five CCs', 9);

        // [b07] what actually arrives (~28.6s).
        //
        // TODO — THE EMAIL FRAME IS BLOCKED, and deliberately not faked here.
        // The offline email's body is built by `buildOfflineEmail` in
        // app/api/cron/health-check/route.ts:207-232, which is module-private.
        // `lib/emailTemplates.server.ts` exports only the chrome
        // (`wrapEmailLayout`, `emailDataTable`, `EMAIL_COLORS`,
        // `emailTimestamp`), so rebuilding the "machines offline" heading and
        // the three grouped sections here would be a copy of product markup that
        // silently drifts the day the route changes — the exact failure mode
        // this audit pass exists to remove.
        //
        // ONE-LINE FIX, then this beat is a `page.setContent()` away:
        //   1. `export` `buildOfflineEmail` from the health-check route (or lift
        //      it into lib/emailTemplates.server.ts beside
        //      `buildDisplayDigestEmail`, which is already exported and is the
        //      precedent).
        //   2. Here: import it, call it with a two-machine `OfflineSections` and
        //      an `unsubscribeUrl`, `await page.setContent(html)`, dwell ~14s
        //      across the subject line, the "machines offline" heading, the
        //      not-responding / shutting-down / still-offline sections, and the
        //      "manage alerts · unsubscribe" footer.
        //
        // What IS filmable today, and what this pass shoots: where that footer
        // link lands. /settings/alerts is the same set of toggles b06 just
        // walked, which is the point the narration makes about it.
        await openForCapture(page, '/settings/alerts');
        await expect(
          page.getByText('machine offline alerts', { exact: false }),
        ).toBeVisible({ timeout: 20_000 });
        await narrate(page, 'b07 where "manage alerts" lands', 16);

        // The beat's hand-off shot: the display panel's store row, which
        // episode 15 opens on.
        await openForCapture(page, '/dashboard');
        const displayButton = page
          .getByTestId('machine-card')
          .filter({ hasText: 'media-server-stage' })
          .getByTestId('open-display-panel');
        await centerInView(page, displayButton);
        await clickWithCursor(page, displayButton);
        await expect(page.getByTestId('display-layout-panel')).toBeVisible();
        await highlight(page, page.getByTestId('display-store-button'), 2400);
        await narrate(page, 'b07 hand-off to display layouts', 13);
      },
    );
  } finally {
    await ctx.cleanup();
  }
});
