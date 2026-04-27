/**
 * Dispatch — store display layout (D3.1)
 *
 * Flow:
 *   1. Seed a machine with a 2-monitor display profile (seedMachine
 *      writes both `sites/{siteId}/machines/{id}` AND
 *      `sites/{siteId}/machines/{id}/hardware/display`).
 *   2. UI: open dashboard, flip to list view, open the display panel,
 *      click "store" on the live tab → confirm dialog → confirm.
 *   3. Firestore: useDisplayActions.captureLayout writes to
 *      `config/{siteId}/machines/{id}.displays.assigned` with
 *      `{ monitors, capturedAt, capturedBy }`.
 *   4. Assert: success toast + assigned tab now has captured monitors
 *      visible + Admin SDK confirms the doc shape.
 *
 * Different collection from D2.x — captureLayout targets
 * `config/{siteId}/...`, not `sites/{siteId}/...`. No agent stub
 * needed: this is a pure client-SDK Firestore write, no command/agent
 * roundtrip.
 *
 * Admin role (the store/restore buttons are isSiteAdmin-gated, per
 * B3.1's coverage of the same DisplayLayoutPanel).
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-store-layout-target';

async function clearAssignedLayout() {
  // Wipe any prior assigned layout so the test starts from a known empty state.
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

  // Use list view's one-click "view displays" — same pattern B3.1 uses for
  // the same panel, so we don't fight the card view's expand-then-click.
  await page.getByTestId('view-toggle-list').click();
  // Multiple machines may have view-displays buttons; scope to our seeded row.
  const row = page.getByTestId('machine-row').filter({ hasText: MACHINE_ID });
  await row.getByTestId('open-display-panel').click();

  const panel = page.getByTestId('display-layout-panel');
  await expect(panel).toBeVisible();

  // Click "store" on the live tab → confirmation dialog.
  await panel.getByTestId('display-store-button').click();

  const confirmDialog = page.getByRole('dialog', { name: /^store current arrangement\?$/i });
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByRole('button', { name: /^store$/i }).click();

  // Wait for the success toast — proves captureLayout's setDoc resolved
  // before we reach for the Admin SDK readback.
  await expect(page.getByText('layout stored', { exact: true })).toBeVisible({ timeout: 10_000 });

  // Admin SDK read-through — config doc now has the assigned layout.
  const db = getAdminDb();
  const configSnap = await db.collection('config').doc(SITE_ID).collection('machines').doc(MACHINE_ID).get();
  const assigned = configSnap.data()?.displays?.assigned;
  expect(assigned).toBeDefined();
  expect(assigned.monitors).toBeDefined();
  expect(Array.isArray(assigned.monitors)).toBe(true);
  expect(assigned.monitors.length).toBe(2); // matches seedMachine's default monitorCount
  expect(typeof assigned.capturedBy).toBe('string');
  expect(assigned.capturedBy.length).toBeGreaterThan(0);

  // UI: switch to the assigned tab — the captured monitors should render now
  // (rather than the empty-state "store current" CTA covered by B3.1).
  await panel.getByRole('button', { name: 'stored', exact: true }).click();
  // The empty-state CTA is gone now that hasAssignedLayout is true.
  await expect(panel.getByTestId('display-store-current-button')).toHaveCount(0);
});
