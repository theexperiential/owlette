/**
 * Dispatch — restore display layout. Dispatch half only: seed a machine with
 * `displays.assigned` (which is what enables the restore button), drive the
 * confirm dialog, assert `useDisplayActions.applyLayout` queues an
 * `apply_display_topology` pending command, and that the success toast plus
 * the amber auto-revert banner render. The ack and expiry paths are covered
 * by their own specs.
 */

import { test, expect } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-recall-layout-target';

async function seedAssignedLayout() {
  // Must mirror seedMachine's monitor shape — wrong field names (positionX,
  // widthPx, isPrimary) crash the panel into the global error boundary.
  const db = getAdminDb();
  await db.collection('config').doc(SITE_ID).collection('machines').doc(MACHINE_ID).set(
    {
      displays: {
        remoteApplyEnabled: true,
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

test('admin restores a layout — apply_display_topology command dispatched + 30s ack banner appears', async ({ page }) => {
  await page.goto('/dashboard');

  await page.getByTestId('view-toggle-list').click();
  const row = page.getByTestId('machine-row').filter({ hasText: MACHINE_ID });
  await row.getByTestId('open-display-panel').click();

  const panel = page.getByTestId('display-layout-panel');
  await expect(panel).toBeVisible();

  // Enabled because hasAssignedLayout is true.
  await panel.getByTestId('display-recall-button').click();

  // Dialog names the machine, so bulk operators can't fire at the wrong one.
  const confirmDialog = page.getByRole('dialog', { name: new RegExp(`restore this layout to ${MACHINE_ID}\\?`, 'i') });
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByRole('button', { name: /^restore$/i }).click();

  // The toast proves applyLayout's setDoc resolved.
  await expect(page.getByText('restore dispatched', { exact: false })).toBeVisible({ timeout: 10_000 });

  // Load-bearing: "keep" within 30s or the agent auto-reverts. role="status"
  // makes it both screen-reader friendly and addressable.
  const banner = panel.getByRole('status');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/keep this layout\? auto-revert in \d+s/);
  await expect(banner.getByRole('button', { name: /^keep$/i })).toBeVisible();

  const db = getAdminDb();
  const pendingSnap = await db
    .collection('sites').doc(SITE_ID)
    .collection('machines').doc(MACHINE_ID)
    .collection('commands').doc('pending').get();
  const pending = pendingSnap.data() ?? {};
  const applyEntries = Object.entries(pending)
    .filter(([, cmd]) => (cmd as { type?: unknown }).type === 'apply_display_topology');
  expect(applyEntries).toHaveLength(1);

  // Firestore: exactly one apply_display_topology entry with the right shape.
  const [, cmd] = applyEntries[0] as [string, Record<string, unknown>];
  expect(cmd.type).toBe('apply_display_topology');
  expect(cmd.status).toBe('pending');
  expect(typeof cmd.applyId).toBe('string');
  expect(cmd.applyId.length).toBeGreaterThan(0);
  const layout = cmd.layout as { monitors?: unknown } | undefined;
  expect(Array.isArray(layout?.monitors)).toBe(true);
  expect((layout!.monitors as unknown[]).length).toBe(1);
});
