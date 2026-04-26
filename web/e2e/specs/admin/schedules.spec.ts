/**
 * Admin — schedule presets page (C3.3)
 *
 * Schedule presets live at `config/{siteId}/schedule_presets/{presetId}`.
 * The `useSchedulePresets` hook merges a Firestore listener with the
 * hardcoded `BUILT_IN_PRESETS` constant — so built-in presets always
 * appear in the list even with an empty Firestore collection.
 *
 * Covered:
 *   - list rendering — the 4 hardcoded built-ins (business hours,
 *     extended hours, weekday 24h, 24/7) all appear with the "built-in"
 *     badge, and their rows lack the trash button (delete guard)
 *   - create flow — "create preset" → fill name → submit → toast + new
 *     row appears + Admin SDK verifies the Firestore doc exists under
 *     `config/{siteId}/schedule_presets/sched-*` with valid blocks
 *   - delete flow — trash on a seeded custom preset → confirmation
 *     dialog → delete → toast + Admin SDK verifies doc gone
 *
 * The time-block editor itself is not exercised — the form falls back
 * to DEFAULT_SCHEDULE (mon-fri 9-5) when no preset is being edited, so
 * "just fill name and save" produces a valid doc.
 */

import { test, expect, type Page } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedSite } from '../../helpers/seed';

test.use(roleState('superadmin'));

const SITE_ID = 'site-schedule-tests';
const SITE_NAME = 'Z Schedule Test Site';

async function clearSchedulePresets() {
  const db = getAdminDb();
  const col = db.collection('config').doc(SITE_ID).collection('schedule_presets');
  const snap = await col.get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

async function seedCustomPreset(name: string) {
  const db = getAdminDb();
  const presetId = `sched-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`;
  await db
    .collection('config')
    .doc(SITE_ID)
    .collection('schedule_presets')
    .doc(presetId)
    .set({
      name,
      description: 'seeded for e2e',
      blocks: [{ days: ['mon', 'tue', 'wed'], ranges: [{ start: '08:00', stop: '18:00' }] }],
      isBuiltIn: false,
      order: 99,
      createdBy: 'super-uid',
      createdAt: Timestamp.now(),
    });
  return presetId;
}

test.beforeEach(async () => {
  await seedSite({ id: SITE_ID, name: SITE_NAME, owner: 'someone-else', timezone: 'UTC' });
  await clearSchedulePresets();
});

async function gotoSchedulesForSeededSite(page: Page) {
  await page.goto('/admin/schedules');
  // Bumped to 10s because RequireSuperadmin renders a "verifying permissions..."
  // gate while AuthContext hydrates against the auth emulator; the default 5s
  // expect timeout occasionally races that hydration on cold-emulator runs.
  await expect(
    page.getByRole('heading', { name: 'schedules', exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  const siteSelect = page.getByRole('combobox');
  await siteSelect.click();
  await page.getByRole('option', { name: SITE_NAME, exact: true }).click();
  await expect(page.getByRole('combobox')).toContainText(SITE_NAME);
}

test('lists all four built-in presets with the built-in badge and no trash', async ({ page }) => {
  await gotoSchedulesForSeededSite(page);

  // The four hardcoded built-ins from web/lib/scheduleDefaults.ts
  const builtIns = ['business hours', 'extended hours', 'weekday 24h', '24/7'];

  for (const name of builtIns) {
    const row = page.locator('div.rounded-lg.border').filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row.getByText('built-in', { exact: true })).toBeVisible();
    // Built-ins have a pencil (to edit/override) but no trash.
    await expect(row.locator('button:has(svg.lucide-pencil)')).toHaveCount(1);
    await expect(row.locator('button:has(svg.lucide-trash-2)')).toHaveCount(0);
  }
});

test('creating a preset writes a Firestore doc with valid blocks', async ({ page }) => {
  await gotoSchedulesForSeededSite(page);

  const presetName = `E2E Custom Preset ${Date.now()}`;
  await page.getByRole('button', { name: /create preset/i }).click();

  // The create dialog uses "Create Schedule Preset" as the title (capitalized).
  const dialog = page.getByRole('dialog', { name: /create schedule preset/i });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('Name').fill(presetName);
  // DEFAULT_SCHEDULE (mon-fri 9-5) is pre-populated, so we skip the blocks
  // editor — clicking Create Preset directly submits a valid schedule.
  await dialog.getByRole('button', { name: /^create preset$/i }).click();

  // Success toast.
  await expect(page.getByText(new RegExp(`"${presetName}" created`, 'i'))).toBeVisible();

  // Row appears in the list.
  const row = page.locator('div.rounded-lg.border').filter({ hasText: presetName });
  await expect(row).toBeVisible();
  // Custom preset — no built-in badge.
  await expect(row.getByText('built-in', { exact: true })).toHaveCount(0);

  // Admin SDK read-through — find the one doc whose name matches.
  const db = getAdminDb();
  const snap = await db
    .collection('config')
    .doc(SITE_ID)
    .collection('schedule_presets')
    .get();
  const matching = snap.docs.find((d) => d.data().name === presetName);
  expect(matching).toBeDefined();
  const data = matching!.data();
  expect(data.isBuiltIn).toBe(false);
  expect(Array.isArray(data.blocks)).toBe(true);
  expect(data.blocks.length).toBeGreaterThan(0);
  // Each seeded block must have at least one day and one range (matches
  // the handleSave filter in SchedulePresetDialog).
  for (const block of data.blocks) {
    expect(block.days.length).toBeGreaterThan(0);
    expect(block.ranges.length).toBeGreaterThan(0);
  }
});

test('deleting a custom preset removes the Firestore doc', async ({ page }) => {
  const presetName = 'Custom to delete';
  const presetId = await seedCustomPreset(presetName);
  await gotoSchedulesForSeededSite(page);

  const row = page.locator('div.rounded-lg.border').filter({ hasText: presetName });
  await expect(row).toBeVisible();
  // Custom preset has a trash button (built-ins don't).
  await row.locator('button:has(svg.lucide-trash-2)').click();

  const confirmDialog = page.getByRole('dialog', { name: /^delete schedule preset$/i });
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog).toContainText(presetName);

  await confirmDialog.getByRole('button', { name: /^delete$/i }).click();

  await expect(page.getByText(new RegExp(`Preset "${presetName}" deleted`, 'i'))).toBeVisible();

  // Admin SDK — doc is gone.
  const db = getAdminDb();
  const snap = await db
    .collection('config')
    .doc(SITE_ID)
    .collection('schedule_presets')
    .doc(presetId)
    .get();
  expect(snap.exists).toBe(false);
});
