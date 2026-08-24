/**
 * Time-travel — display apply deadline auto-revert UI.
 *
 * DisplayLayoutPanel sets `ackDeadlineMs = Date.now() + 30_000` on a successful
 * apply dispatch, then a 250ms interval clears state and toasts "no confirmation
 * sent — agent will auto-revert" once it passes.
 *
 * Driven via page.clock, installed BEFORE goto so the interval is captured from
 * mount: seed the assigned layout, dispatch restore, fastForward 31s.
 */

import { test, expect } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-apply-deadline-target';

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

async function seedAssignedLayout() {
  const db = getAdminDb();
  await db.collection('config').doc(SITE_ID).collection('machines').doc(MACHINE_ID).set(
    {
      displays: {
        remoteApplyEnabled: true,
        assigned: {
          monitors: [monitor(0, { x: 0, y: 0 }), monitor(1, { x: 1920, y: 0 })],
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

test('apply deadline expires without ack — banner clears + auto-revert toast fires', async ({ page }) => {
  const realNow = Date.now();
  // Clock BEFORE navigation, anchored at Date.now() so Firebase Auth's timing
  // still resolves and the dashboard doesn't stall on "buffering…".
  await page.clock.install({ time: realNow });

  await seedMachine(SITE_ID, MACHINE_ID);
  await clearMachineCommands();
  await seedAssignedLayout();

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

  // Two role="status" elements exist (ack banner + loading spinner), and a
  // restore can re-flip `loading` mid-tick, so a bare getByRole('status') hits
  // a strict-mode violation. Scope by the banner's text.
  const banner = panel.getByRole('status').filter({ hasText: /keep this layout/i });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/keep this layout\? auto-revert in \d+s/);

  // Past the 30s deadline, so at least one 250ms tick sees it expired.
  await page.clock.fastForward(31_000);

  // Banner clears once ackDeadlineMs is null.
  await expect(banner).toHaveCount(0, { timeout: 5_000 });
  // Auto-revert toast — exact wording from DisplayLayoutPanel.
  await expect(
    page.getByText('no confirmation sent — agent will auto-revert', { exact: true }),
  ).toBeVisible();
});
