/**
 * Dispatch — restore success path. Seed a drifted assigned layout, restore,
 * stub the agent's apply (live profile now matches assigned + completeCommand),
 * then "keep" → ack_display_topology + banner dismissed + drift cleared.
 *
 * The banner dismisses client-side on the keep click, NOT on agent completion;
 * the completion stub is what makes the read-through assertions prove real
 * end-to-end success rather than just the local UI state machine.
 */

import { test, expect } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';
import { completeCommand } from '../../helpers/stubAgent';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-recall-success-target';

/** One monitor in seedMachine's shape, with a caller-chosen position. */
function monitor(index: number, position: { x: number; y: number }) {
  return {
    id: `MONITOR\\TEST${index}`,
    edidHash: `hash-${MACHINE_ID}-${index}`,
    manufacturerId: 'TST',
    productCode: `000${index}`,
    serialNumber: `SN${index}`,
    friendlyName: `Test Monitor ${index + 1}`,
    position,
    resolution: { width: 1920, height: 1080 },
    refreshHz: 60,
    rotation: 0,
    scalePct: 100,
    primary: index === 0,
    connectionType: 'dp',
    adapterLuid: '0:0',
    targetId: index,
  };
}

const ASSIGNED_MONITORS = [
  monitor(0, { x: 0, y: 0 }),
  monitor(1, { x: 1920, y: 0 }),
];

async function seedAssignedLayout(monitors = ASSIGNED_MONITORS) {
  const db = getAdminDb();
  await db.collection('config').doc(SITE_ID).collection('machines').doc(MACHINE_ID).set(
    {
      displays: {
        remoteApplyEnabled: true,
        assigned: {
          monitors,
          capturedAt: Timestamp.now(),
          capturedBy: 'admin@e2e.test',
        },
      },
    },
    { merge: true },
  );
}

/**
 * Stub the agent's os-level apply: overwrite live hardware/display to match
 * assigned, which flips the snapshot listener's drift map to empty.
 */
async function stubLivePushMatchingAssigned() {
  const db = getAdminDb();
  await db
    .collection('sites').doc(SITE_ID)
    .collection('machines').doc(MACHINE_ID)
    .collection('hardware').doc('display')
    .set({
      schemaVersion: 1,
      signatureHash: `sig-${MACHINE_ID}`,
      capturedAt: Date.now(),
      monitors: ASSIGNED_MONITORS,
      mosaicActive: false,
    });
}

async function clearMachineCommands() {
  const db = getAdminDb();
  const col = db.collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID).collection('commands');
  const snap = await col.get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

async function getPendingCommandEntries() {
  const db = getAdminDb();
  const snap = await db
    .collection('sites').doc(SITE_ID)
    .collection('machines').doc(MACHINE_ID)
    .collection('commands').doc('pending').get();
  return Object.entries(snap.data() ?? {}) as Array<[string, Record<string, unknown>]>;
}

test.beforeEach(async () => {
  // seedMachine's live default is 2 monitors at (0,0) and (1920,0), matching
  // ASSIGNED_MONITORS — so assigned gets a shifted second monitor to force
  // drift until the agent stub fires.
  await seedMachine(SITE_ID, MACHINE_ID);
  await clearMachineCommands();
  await seedAssignedLayout([
    monitor(0, { x: 0, y: 0 }),
    monitor(1, { x: 1920, y: 100 }), // y=100 vs live's y=0
  ]);
});

test('admin restores a drifted layout — agent applies + operator keeps + banner dismisses + drift clears', async ({ page }) => {
  await page.goto('/dashboard');
  await page.getByTestId('view-toggle-list').click();
  const row = page.getByTestId('machine-row').filter({ hasText: MACHINE_ID });
  await row.getByTestId('open-display-panel').click();

  const panel = page.getByTestId('display-layout-panel');
  await expect(panel).toBeVisible();

  await panel.getByTestId('display-recall-button').click();
  const confirmDialog = page.getByRole('dialog', { name: new RegExp(`restore this layout to ${MACHINE_ID}\\?`, 'i') });
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByRole('button', { name: /^restore$/i }).click();

  const banner = panel.getByRole('status');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/keep this layout\?/);

  // Command id needed to stub its completion.
  const applyEntries = (await getPendingCommandEntries())
    .filter(([, cmd]) => cmd.type === 'apply_display_topology');
  expect(applyEntries).toHaveLength(1);
  const [applyCmdId] = applyEntries[0];

  await stubLivePushMatchingAssigned();
  await completeCommand(SITE_ID, MACHINE_ID, applyCmdId, { applied: true }, { cmdType: 'apply_display_topology' });

  // Keep fires ack_display_topology; the click is what dismisses the banner.
  await banner.getByRole('button', { name: /^keep$/i }).click();
  await expect(page.getByText('ack sent', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(banner).toBeHidden();

  // Firestore: ack_display_topology written, apply moved pending → completed.
  const db = getAdminDb();
  const pendingAfter = await getPendingCommandEntries();
  const ackEntries = pendingAfter.filter(([, cmd]) => cmd.type === 'ack_display_topology');
  expect(ackEntries).toHaveLength(1);
  expect(pendingAfter.map(([id]) => id)).not.toContain(applyCmdId);

  const completedSnap = await db
    .collection('sites').doc(SITE_ID)
    .collection('machines').doc(MACHINE_ID)
    .collection('commands').doc('completed').get();
  expect(completedSnap.data()![applyCmdId].status).toBe('completed');

  const pendingSnap = await db
    .collection('sites').doc(SITE_ID)
    .collection('machines').doc(MACHINE_ID)
    .collection('commands').doc('pending').get();
  const ackCmd = pendingSnap.data()![ackEntries[0][0]];
  expect(ackCmd.type).toBe('ack_display_topology');
  expect(typeof ackCmd.applyId).toBe('string');
  expect(ackCmd.applyId.length).toBeGreaterThan(0);
});
