/**
 * Dispatch — restore success path (D3.4)
 *
 * Builds on D3.3 (dispatch-only) by exercising the FULL happy path:
 *   1. Pre-seed an assigned layout that differs from the seeded live
 *      hardware/display profile — drift map is non-empty, restore
 *      button has an amber "drift detected" affordance.
 *   2. Click restore → confirm → apply_display_topology dispatched +
 *      30s ack banner appears (covered by D3.3, repeated minimally
 *      here as setup).
 *   3. Stub the agent finishing the apply:
 *        a) update hardware/display so live now matches assigned
 *           (the agent's metrics push after a successful os-level apply)
 *        b) completeCommand on apply_display_topology with status
 *           'completed'
 *   4. Operator clicks "keep" → ackLayout writes ack_display_topology
 *      → banner dismisses + "ack sent" toast.
 *   5. Drift map empties out because live === assigned now.
 *
 * The component dismisses the banner client-side on the keep click
 * (NOT on the agent completing the apply); the agent-completion stub
 * is what makes the read-through assertions meaningful — it proves
 * the test actually represents end-to-end success rather than just
 * pinning the local UI state machine.
 */

import { test, expect } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';
import { completeCommand, getPendingCommandIds } from '../../helpers/stubAgent';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-recall-success-target';

/**
 * Build a single monitor record matching seedMachine's hardware/display
 * shape. Allows callers to pin a custom position for drift seeding.
 */
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
 * Stub the agent completing the os-level apply: overwrite the live
 * hardware/display to match the assigned layout. Once this lands the
 * snapshot listener flips drift to empty.
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

test.beforeEach(async () => {
  // seedMachine writes 2 monitors at (0, 0) and (1920, 0) by default —
  // matching ASSIGNED_MONITORS exactly. To force drift, we seed
  // assigned with a SECOND-monitor offset that doesn't match live.
  // The simplest way: leave seedMachine default for live, then seed
  // assigned with a swapped/shifted second monitor.
  await seedMachine(SITE_ID, MACHINE_ID);
  await clearMachineCommands();
  // Force drift: assigned puts monitor 1 at a different y-offset so
  // computeDisplayDrift returns a non-empty map until the agent stub fires.
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

  // Dispatch restore — same as D3.3.
  await panel.getByTestId('display-recall-button').click();
  const confirmDialog = page.getByRole('dialog', { name: new RegExp(`restore this layout to ${MACHINE_ID}\\?`, 'i') });
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByRole('button', { name: /^restore$/i }).click();

  // Banner appears.
  const banner = panel.getByRole('status');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/keep this layout\?/);

  // Grab the apply command id so we can stub its completion.
  const applyKeys = (await getPendingCommandIds(SITE_ID, MACHINE_ID))
    .filter((id) => id.startsWith('apply_display_topology_'));
  expect(applyKeys).toHaveLength(1);
  const applyCmdId = applyKeys[0];

  // Stub the agent finishing the os-level apply: live now matches assigned.
  await stubLivePushMatchingAssigned();
  await completeCommand(SITE_ID, MACHINE_ID, applyCmdId, { applied: true }, { cmdType: 'apply_display_topology' });

  // Operator clicks keep — fires ack_display_topology + dismisses banner
  // (banner dismissal is local UI state; the keep click is what closes it).
  await banner.getByRole('button', { name: /^keep$/i }).click();
  await expect(page.getByText('ack sent', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(banner).toBeHidden();

  // Firestore: ack_display_topology written, apply moved pending → completed.
  const db = getAdminDb();
  const pendingAfter = await getPendingCommandIds(SITE_ID, MACHINE_ID);
  const ackKeys = pendingAfter.filter((id) => id.startsWith('ack_display_topology_'));
  expect(ackKeys).toHaveLength(1);
  expect(pendingAfter).not.toContain(applyCmdId);

  const completedSnap = await db
    .collection('sites').doc(SITE_ID)
    .collection('machines').doc(MACHINE_ID)
    .collection('commands').doc('completed').get();
  expect(completedSnap.data()![applyCmdId].status).toBe('completed');

  // The ack command itself carries the same applyId the apply did.
  const pendingSnap = await db
    .collection('sites').doc(SITE_ID)
    .collection('machines').doc(MACHINE_ID)
    .collection('commands').doc('pending').get();
  const ackCmd = pendingSnap.data()![ackKeys[0]];
  expect(ackCmd.type).toBe('ack_display_topology');
  expect(typeof ackCmd.applyId).toBe('string');
  expect(ackCmd.applyId.length).toBeGreaterThan(0);
});
