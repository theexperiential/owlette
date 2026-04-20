/**
 * Admin — alerts page (C3.4)
 *
 * Alert rules are stored differently from webhooks/schedules: a single
 * Firestore doc at `sites/{siteId}/settings/alerts` with a `rules`
 * array field. Each rule carries id, name, metric, operator, value,
 * severity, channels, enabled, cooldownMinutes.
 *
 * Covered:
 *   - list rendering — a seeded rule appears with severity badge and
 *     the metric-summary line ("CPU usage (%) > 80 · email · cooldown 30m")
 *   - create flow — open dialog → fill form → create → toast + row +
 *     Admin SDK verifies the rules array now contains the new entry
 *   - add preset — presets dropdown → pick "GPU Overheating" → toast +
 *     row + Admin SDK verifies
 *   - toggle enabled — click the Switch on a seeded-enabled rule →
 *     Admin SDK verifies `rules[0].enabled === false`
 *   - delete — trash → confirmation dialog → delete → Admin SDK
 *     verifies the rules array no longer contains the deleted rule
 */

import { test, expect, type Page } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedSite } from '../../helpers/seed';

test.use(roleState('superadmin'));

const SITE_ID = 'site-alert-tests';
const SITE_NAME = 'Z Alert Test Site';

interface AlertRule {
  id: string;
  name: string;
  metric: string;
  operator: '>' | '<' | '>=' | '<=';
  value: number;
  severity: 'info' | 'warning' | 'critical';
  channels: string[];
  enabled: boolean;
  cooldownMinutes: number;
}

const SEEDED_RULE: AlertRule = {
  id: 'seeded-rule-id',
  name: 'seeded test rule',
  metric: 'cpu_percent',
  operator: '>',
  value: 80,
  severity: 'warning',
  channels: ['email'],
  enabled: true,
  cooldownMinutes: 30,
};

async function setAlertRules(rules: AlertRule[]) {
  const db = getAdminDb();
  await db
    .collection('sites').doc(SITE_ID)
    .collection('settings').doc('alerts')
    .set({ rules }, { merge: true });
}

async function getAlertRules(): Promise<AlertRule[]> {
  const db = getAdminDb();
  const snap = await db
    .collection('sites').doc(SITE_ID)
    .collection('settings').doc('alerts')
    .get();
  return (snap.data()?.rules ?? []) as AlertRule[];
}

test.beforeEach(async () => {
  await seedSite({ id: SITE_ID, name: SITE_NAME, owner: 'someone-else', timezone: 'UTC' });
  // Reset to empty rules; individual tests can then seed what they need.
  await setAlertRules([]);
});

async function gotoAlertsForSeededSite(page: Page) {
  await page.goto('/admin/alerts');
  await expect(page.getByRole('heading', { name: 'alerts', exact: true })).toBeVisible();
  const siteSelect = page.getByRole('combobox').first();
  await siteSelect.click();
  await page.getByRole('option', { name: SITE_NAME, exact: true }).click();
  await expect(siteSelect).toContainText(SITE_NAME);
}

test('lists a seeded rule with its severity badge and summary line', async ({ page }) => {
  await setAlertRules([SEEDED_RULE]);
  await gotoAlertsForSeededSite(page);

  const row = page.locator('div.rounded-lg.border').filter({ hasText: SEEDED_RULE.name });
  await expect(row).toBeVisible();
  // Severity badge.
  await expect(row.getByText('warning', { exact: true })).toBeVisible();
  // Summary line — the page renders getMetricLabel(metric) so "cpu_percent"
  // displays as "CPU usage (%)". Assert on the operator + threshold + channel.
  await expect(row).toContainText('> 80');
  await expect(row).toContainText('email');
  await expect(row).toContainText('cooldown 30m');
});

test('creating a rule adds it to the Firestore rules array', async ({ page }) => {
  await gotoAlertsForSeededSite(page);

  // With an empty rules array, the page renders TWO "create rule" buttons
  // (header + empty-state CTA). Either opens the same dialog.
  await page.getByRole('button', { name: /^create rule$/i }).first().click();

  const dialog = page.getByRole('dialog', { name: /^create alert rule$/i });
  await expect(dialog).toBeVisible();

  const ruleName = `E2E rule ${Date.now()}`;
  await dialog.getByLabel('name').fill(ruleName);
  // metric + operator + severity keep their defaults (cpu_percent, >, warning)
  await dialog.getByLabel('threshold').fill('95');
  // cooldown defaults to 30 (see openCreateDialog)

  await dialog.getByRole('button', { name: /^create$/i }).click();

  await expect(page.getByText('Rule created', { exact: true })).toBeVisible();

  // Row appears in the list.
  const row = page.locator('div.rounded-lg.border').filter({ hasText: ruleName });
  await expect(row).toBeVisible();

  // Admin SDK — the rules array now has exactly one entry matching.
  const rules = await getAlertRules();
  const matching = rules.find((r) => r.name === ruleName);
  expect(matching).toBeDefined();
  expect(matching!.metric).toBe('cpu_percent');
  expect(matching!.operator).toBe('>');
  expect(matching!.value).toBe(95);
  expect(matching!.severity).toBe('warning');
  expect(matching!.channels).toEqual(expect.arrayContaining(['email', 'webhook']));
  expect(matching!.enabled).toBe(true);
});

test('adding a preset from the dropdown writes the template rule to Firestore', async ({ page }) => {
  await gotoAlertsForSeededSite(page);

  await page.getByRole('button', { name: /^presets$/i }).click();
  // The dropdown menu items are labelled "GPU Overheating (gpu temp > 85)".
  await page.getByRole('menuitem', { name: /^GPU Overheating/ }).click();

  await expect(page.getByText('Preset "GPU Overheating" added', { exact: true })).toBeVisible();

  const rules = await getAlertRules();
  const gpu = rules.find((r) => r.name === 'GPU Overheating');
  expect(gpu).toBeDefined();
  expect(gpu!.metric).toBe('gpu_temp');
  expect(gpu!.operator).toBe('>');
  expect(gpu!.value).toBe(85);
});

test('toggling the enabled switch flips the rule in Firestore', async ({ page }) => {
  await setAlertRules([SEEDED_RULE]);
  await gotoAlertsForSeededSite(page);

  const row = page.locator('div.rounded-lg.border').filter({ hasText: SEEDED_RULE.name });
  // shadcn Switch renders as role="switch".
  const toggle = row.getByRole('switch');
  await expect(toggle).toHaveAttribute('data-state', 'checked');
  await toggle.click();
  // UI should flip to unchecked.
  await expect(toggle).toHaveAttribute('data-state', 'unchecked');

  // Admin SDK — rule is now disabled.
  const rules = await getAlertRules();
  const updated = rules.find((r) => r.id === SEEDED_RULE.id);
  expect(updated).toBeDefined();
  expect(updated!.enabled).toBe(false);
});

test('deleting a rule removes it from the Firestore rules array', async ({ page }) => {
  await setAlertRules([SEEDED_RULE]);
  await gotoAlertsForSeededSite(page);

  const row = page.locator('div.rounded-lg.border').filter({ hasText: SEEDED_RULE.name });
  await row.locator('button:has(svg.lucide-trash-2)').click();

  const confirm = page.getByRole('dialog', { name: /^delete alert rule$/i });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(SEEDED_RULE.name);
  await confirm.getByRole('button', { name: /^delete$/i }).click();

  await expect(page.getByText('Rule deleted', { exact: true })).toBeVisible();

  const rules = await getAlertRules();
  expect(rules.find((r) => r.id === SEEDED_RULE.id)).toBeUndefined();
});
