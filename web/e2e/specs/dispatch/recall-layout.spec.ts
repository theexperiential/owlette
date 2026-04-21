/**
 * Dispatch — recall display layout (D3.3)
 *
 * No time-travel here (D3.4 covers the success-ack path; E2.x covers
 * the deadline-expiry path). This spec just validates the dispatch
 * half:
 *
 *   1. Seed machine + pre-populate config doc's `displays.assigned`
 *      so the recall button is enabled (gated on hasAssignedLayout).
 *   2. UI: list view → display panel → recall button → confirm dialog
 *      "recall this layout to {machineId}?" → confirm.
 *   3. Firestore: useDisplayActions.applyLayout writes
 *      `apply_display_topology_{Date.now()}` to commands/pending
 *      with `{ type, layout: { monitors }, applyId, status: 'pending' }`.
 *   4. UI: success toast + amber "keep this layout? auto-revert in 30s"
 *      banner appears (role="status" with the "keep" button).
 */

import { test, expect } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';
import { getPendingCommandIds } from '../../helpers/stubAgent';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-recall-layout-target';

async function seedAssignedLayout() {
  // Mirror seedMachine's hardware/display monitor shape — using the wrong
  // field names (positionX, widthPx, isPrimary) crashes the panel into
  // its global error boundary. Lesson learned in D3.2.
  const db = getAdminDb();
  await db.collection('config').doc(SITE_ID).collection('machines').doc(MACHINE_ID).set(
    {
      displays: {
        assigned: {
          monitors: [
            {
              id: `MONITOR\\TEST0`,
              edidHash: `hash-${MACHINE_ID}-0`,
              manufacturerId: 'TST',
              productCode: '0000',
              serialNumber: 'SN0',
              friendlyName: 'Test Monitor 1',
              position: { x: 0, y: 0 },
              resolution: { width: 1920, height: 1080 },
              refreshHz: 60,
              rotation: 0,
              scalePct: 100,
              primary: true,
              connectionType: 'dp',
              adapterLuid: '0:0',
              targetId: 0,
            },
          ],
          capturedAt: Timestamp.now(),
          capturedBy: 'admin@e2e.test',
        },
      },
    },
    { merge: true },
  );
}

async function clearMachineCommands() {
  const db = getAdminDb();
  const col = db.collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID).collection('commands');
  const snap = await col.get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

test.beforeEach(async () => {
  await seedMachine(SITE_ID, MACHINE_ID);
  await clearMachineCommands();
  await seedAssignedLayout();
});

test('admin recalls a layout — apply_display_topology command dispatched + 30s ack banner appears', async ({ page }) => {
  await page.goto('/dashboard');

  await page.getByTestId('view-toggle-list').click();
  const row = page.getByTestId('machine-row').filter({ hasText: MACHINE_ID });
  await row.getByTestId('open-display-panel').click();

  const panel = page.getByTestId('display-layout-panel');
  await expect(panel).toBeVisible();

  // Recall button is enabled because hasAssignedLayout is true.
  await panel.getByTestId('display-recall-button').click();

  // Confirmation dialog title includes the machine identifier so bulk
  // operators don't fire against the wrong machine.
  const confirmDialog = page.getByRole('dialog', { name: new RegExp(`recall this layout to ${MACHINE_ID}\\?`, 'i') });
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByRole('button', { name: /^recall$/i }).click();

  // Wait for the success toast — proves applyLayout's setDoc resolved.
  await expect(page.getByText('recall dispatched', { exact: false })).toBeVisible({ timeout: 10_000 });

  // The amber ack banner is the load-bearing UI signal — operator must
  // press "keep" within 30s or the agent auto-reverts. role="status"
  // makes it screen-reader friendly AND addressable.
  const banner = panel.getByRole('status');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/keep this layout\? auto-revert in \d+s/);
  await expect(banner.getByRole('button', { name: /^keep$/i })).toBeVisible();

  // Firestore: exactly one apply_display_topology_* entry with the right shape.
  const pendingIds = await getPendingCommandIds(SITE_ID, MACHINE_ID);
  const applyKeys = pendingIds.filter((id) => id.startsWith('apply_display_topology_'));
  expect(applyKeys).toHaveLength(1);

  const db = getAdminDb();
  const pendingSnap = await db
    .collection('sites').doc(SITE_ID)
    .collection('machines').doc(MACHINE_ID)
    .collection('commands').doc('pending').get();
  const cmd = pendingSnap.data()![applyKeys[0]];
  expect(cmd.type).toBe('apply_display_topology');
  expect(cmd.status).toBe('pending');
  expect(typeof cmd.applyId).toBe('string');
  expect(cmd.applyId.length).toBeGreaterThan(0);
  expect(Array.isArray(cmd.layout?.monitors)).toBe(true);
  expect(cmd.layout.monitors.length).toBe(1);
});
