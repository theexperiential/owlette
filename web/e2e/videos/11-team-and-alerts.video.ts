/**
 * Scene — episode 11, "team & alerts".
 *
 * Every beat in this episode is SCREEN capture (no B-ROLL). Beat list with
 * rendered VO durations (voiceover/out/11-team-and-alerts/, ffprobe):
 *   b01 how the team works                ~18.5s  → /admin/users list
 *   b02 assign a role and sites           ~20.0s  → row menu → change role dialog
 *   b03 what each role can do             ~38.8s  → scroll the 3 role-description cards
 *   b04 alerts: let owlette tell you      ~12.4s  → /admin/alerts list of rules
 *   b05 build a rule                      ~33.2s  → create-rule dialog + presets menu
 *   b06 your personal alert preferences   ~30.7s  → account settings → alerts tab
 *
 * NOTE from the script: admin pages require superadmin. The base scenario
 * `automate-schedule-editor` does seed sites/{id}/alertRules/* but that's the
 * automation-rule schema, NOT the threshold-rule schema the /admin/alerts page
 * reads (sites/{id}/settings/alerts.rules[]). So this scene seeds the email-
 * alerts schema inline before navigating — mirrors what email-alerts.spec.ts
 * does for the docs screenshot.
 *
 * Run:  cd web && npm run videos -- --grep "episode 11"
 * Out:  web/e2e/.output/videos/11-team-and-alerts.mp4
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

test('episode 11 — team & alerts', async ({ browser }) => {
  const ctx = await seedScreenshotFixtures('automate-schedule-editor');
  try {
    // Pin the superadmin onto the seeded site so the per-site selectors on
    // /admin/alerts and /admin/users land on real data.
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.superadmin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    // Seed threshold-rule schema on settings/alerts — the schema /admin/alerts
    // actually reads. Mirrors web/e2e/screenshots/email-alerts.spec.ts.
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
      '11-team-and-alerts',
      { baseURL: E2E_BASE_URL, storageState: roleState('superadmin').storageState },
      async (page) => {
        // [b01] how the team works — settle on the user-management page (~18.5s VO).
        await openForCapture(page, '/admin/users');
        await expect(
          page.getByRole('heading', { name: 'user management', exact: true }),
        ).toBeVisible();
        // The seeded test users (member@e2e.test, admin@e2e.test, super@e2e.test)
        // populate the table.
        await expect(page.getByText('admin@e2e.test', { exact: false }).first()).toBeVisible();
        await narrate(page, 'b01 user list — settle', 19);

        // [b02] assign a role and sites (~20.0s VO).
        // Open the row menu for the member user and step into "change role...".
        const memberRow = page
          .getByRole('row')
          .filter({ hasText: 'member@e2e.test' });
        const memberActions = memberRow.getByRole('button').last(); // VERIFY — MoreVertical button is the last button in the row
        await centerInView(page, memberRow);
        await clickWithCursor(page, memberActions);
        const changeRoleItem = page.getByRole('menuitem', { name: /change role/i });
        await expect(changeRoleItem).toBeVisible();
        await clickWithCursor(page, changeRoleItem);

        // Role-change dialog with the role select.
        const roleDialog = page.getByRole('dialog', { name: /change role/i });
        await expect(roleDialog).toBeVisible();
        // Open the select to surface member/admin/superadmin options.
        const roleSelectTrigger = roleDialog.getByRole('combobox').first(); // VERIFY — first combobox = role select
        await clickWithCursor(page, roleSelectTrigger);
        await page.waitForTimeout(400);
        const adminOption = page.getByRole('option', { name: /^admin$/i }).first();
        await expect(adminOption).toBeVisible();
        await highlight(page, adminOption, 1600);
        await narrate(page, 'b02 role select open', 12);
        // Pick admin so the cyan description card shows the admin scope.
        await clickWithCursor(page, adminOption);
        await narrate(page, 'b02 admin description', 4);
        // Cancel back out — we're not actually mutating the seeded users.
        await clickWithCursor(page, roleDialog.getByRole('button', { name: /^cancel$/i }));
        await expect(roleDialog).not.toBeVisible();

        // [b03] what each role can do (~38.8s VO).
        // The three role-description cards live at the bottom of the page —
        // pan slowly to them so all three are framed together.
        await slowScrollToBottom(page, 6);
        const memberRoleCard = page
          .locator('div')
          .filter({ hasText: /standard access to assigned sites/i })
          .first();
        await centerInView(page, memberRoleCard);
        await highlight(page, memberRoleCard, 1800);
        await narrate(page, 'b03 member role', 11);
        const adminRoleCard = page
          .locator('div')
          .filter({ hasText: /site-scoped elevated tier/i })
          .first();
        await highlight(page, adminRoleCard, 1800);
        await narrate(page, 'b03 admin role', 13);
        const superadminRoleCard = page
          .locator('div')
          .filter({ hasText: /platform-wide god-mode/i })
          .first();
        await highlight(page, superadminRoleCard, 1800);
        await narrate(page, 'b03 superadmin role', 9);

        // [b04] alerts: let owlette tell you (~12.4s VO).
        await page.goto('/admin/alerts');
        await page.waitForTimeout(1000);
        await expect(
          page.getByRole('heading', { name: 'alerts', exact: true }),
        ).toBeVisible();
        await expect(page.getByText('GPU Overheating', { exact: false })).toBeVisible();
        await narrate(page, 'b04 alerts list settle', 12);

        // [b05] build a rule (~33.2s VO).
        const createRuleBtn = page.getByRole('button', { name: /create rule/i }).first();
        await clickWithCursor(page, createRuleBtn);
        const ruleDialog = page.getByRole('dialog', { name: /create alert rule/i });
        await expect(ruleDialog).toBeVisible();

        // Name the rule.
        const nameInput = ruleDialog.locator('#rule-name');
        await typewrite(page, nameInput, 'GPU overheat', 45);

        // Open the metric select and pick GPU temperature.
        const metricTrigger = ruleDialog.getByRole('combobox').nth(0); // VERIFY — selects: metric, operator, severity
        await clickWithCursor(page, metricTrigger);
        await page.waitForTimeout(300);
        const gpuTempOption = page.getByRole('option', { name: /GPU temperature/i });
        await clickWithCursor(page, gpuTempOption);

        // Threshold value.
        const valueInput = ruleDialog.locator('#rule-value');
        await typewrite(page, valueInput, '85', 60);

        // Severity → warning is the default; open + highlight to show the options.
        const severityTrigger = ruleDialog.getByRole('combobox').nth(2); // VERIFY — third combobox = severity
        await clickWithCursor(page, severityTrigger);
        await page.waitForTimeout(300);
        const warningOption = page.getByRole('option', { name: /^warning$/i });
        await highlight(page, warningOption, 1200);
        await clickWithCursor(page, warningOption);
        await narrate(page, 'b05 rule body filled', 18);

        // Cancel and demo the presets menu instead.
        await clickWithCursor(page, ruleDialog.getByRole('button', { name: /^cancel$/i }));
        await expect(ruleDialog).not.toBeVisible();
        const presetsBtn = page.getByRole('button', { name: /^presets$/i }).first();
        await clickWithCursor(page, presetsBtn);
        const firstPreset = page.getByRole('menuitem', { name: /GPU Overheating/i }).first();
        await expect(firstPreset).toBeVisible();
        await highlight(page, firstPreset, 2000);
        await narrate(page, 'b05 presets list', 15);
        // Dismiss the menu without applying so we don't add a duplicate rule.
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);

        // [b06] your personal alert preferences (~30.7s VO).
        // The admin layout (web/app/admin/layout.tsx) does NOT render PageHeader,
        // so `user-menu-trigger` doesn't exist on /admin/alerts. Navigate back to
        // the dashboard (which mounts PageHeader + wires onAccountSettings) before
        // opening the avatar menu. Pattern matches account-settings specs
        // (web/e2e/specs/account/preferences.spec.ts:45-47, etc).
        await page.goto('/dashboard');
        await page.waitForTimeout(800);
        const userMenuTrigger = page.getByTestId('user-menu-trigger');
        await clickWithCursor(page, userMenuTrigger);
        const accountSettingsItem = page.getByRole('menuitem', { name: /account settings/i });
        await expect(accountSettingsItem).toBeVisible();
        await clickWithCursor(page, accountSettingsItem);

        const settingsDialog = page.getByRole('dialog'); // VisuallyHidden DialogTitle, no accessible name
        await expect(settingsDialog).toBeVisible();
        // Click the "alerts" tab in the settings sidebar.
        const alertsTab = settingsDialog.getByRole('button', { name: /^alerts$/i }).first();
        await clickWithCursor(page, alertsTab);
        await expect(
          settingsDialog.getByText('machine offline alerts', { exact: false }),
        ).toBeVisible();
        await narrate(page, 'b06 alerts tab — toggles', 16);

        // Pan to the alert email + CC recipients section near the bottom.
        const alertEmailSection = settingsDialog
          .getByText('alert email', { exact: true })
          .first();
        await centerInView(page, alertEmailSection);
        await highlight(page, alertEmailSection, 1800);
        await narrate(page, 'b06 alert email + CC', 15);
      },
    );
  } finally {
    await ctx.cleanup();
  }
});
