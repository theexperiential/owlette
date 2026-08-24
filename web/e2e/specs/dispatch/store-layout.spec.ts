/**
 * Dispatch — store display layout (D3.1): seed a 2-monitor profile, click "store"
 * on the live tab, confirm, then assert the toast, the assigned tab, and the
 * `config/{siteId}/machines/{id}.displays.assigned` doc shape.
 *
 * Note the collection: captureLayout writes to `config/...`, not `sites/...`,
 * and is a pure client-SDK write — no agent roundtrip, so no stub needed.
 * Admin role because the store/restore buttons are isSiteAdmin-gated (B3.1).
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-store-layout-target';

async function clearAssignedLayout() {
  // start from a known-empty assigned layout
  const db = getAdminDb();
  await db.collection('config').doc(SITE_ID).collection('machines').doc(MACHINE_ID).set(
    { displays: { assigned: null } },
    { merge: true },
  );
}

test.beforeEach(async () => {
  await seedMachine(SITE_ID, MACHINE_ID);
  await clearAssignedLayout();
});

test('admin stores a display layout — capture writes config doc + assigned tab populates', async ({ page }) => {
  await page.goto('/dashboard');

  // list view's one-click "view displays" avoids the card view's expand-then-click
  await page.getByTestId('view-toggle-list').click();
  // scope to our seeded row; other machines have the same button
  const row = page.getByTestId('machine-row').filter({ hasText: MACHINE_ID });
  await row.getByTestId('open-display-panel').click();

  const panel = page.getByTestId('display-layout-panel');
  await expect(panel).toBeVisible();

  await panel.getByTestId('display-store-button').click();

  const confirmDialog = page.getByRole('dialog', { name: /^store current arrangement\?$/i });
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByRole('button', { name: /^store$/i }).click();

  // the toast proves setDoc resolved before the Admin SDK readback
  await expect(page.getByText('layout stored', { exact: true })).toBeVisible({ timeout: 10_000 });

  const db = getAdminDb();
  const configSnap = await db.collection('config').doc(SITE_ID).collection('machines').doc(MACHINE_ID).get();
  const assigned = configSnap.data()?.displays?.assigned;
  expect(assigned).toBeDefined();
  expect(assigned.monitors).toBeDefined();
  expect(Array.isArray(assigned.monitors)).toBe(true);
  expect(assigned.monitors.length).toBe(2); // matches seedMachine's default monitorCount
  expect(typeof assigned.capturedBy).toBe('string');
  expect(assigned.capturedBy.length).toBeGreaterThan(0);

  // assigned tab now renders monitors instead of B3.1's empty-state CTA
  await panel.getByRole('button', { name: 'stored', exact: true }).click();
  await expect(panel.getByTestId('display-store-current-button')).toHaveCount(0);
});
