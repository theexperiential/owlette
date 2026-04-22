/**
 * Time-travel — apply + ack BEFORE deadline (E2.2)
 *
 * Inverse of E2.1. Exercises the operator-keeps-layout path against
 * a fake clock partway into the 30s ack window:
 *
 *   1. Install clock (E1.2 pattern) + seed assigned layout.
 *   2. Dispatch recall → banner appears with deadline = t+30s.
 *   3. fastForward 15s — banner still up, countdown halfway.
 *   4. Click "keep" → ackLayout writes ack_display_topology + banner
 *      dismisses locally + "layout kept" toast fires.
 *   5. fastForward another 20s — confirms the deadline-expiry
 *      setInterval was cleared on keep (no auto-revert toast fires
 *      even though wall-clock equivalent has elapsed past 30s).
 *
 * The last step is the load-bearing addition vs D3.4's operator-keep
 * coverage: D3.4 proved keep works, E2.2 proves keep disarms the
 * deadline watchdog. A regression that kept the banner-dismiss but
 * left the setInterval running would show up only here.
 */

import { test, expect } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-apply-ack-target';

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

test('operator keeps the layout at t=15s — banner dismisses + no auto-revert fires past deadline', async ({ page }) => {
  const realNow = Date.now();
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
  const confirmDialog = page.getByRole('dialog', { name: new RegExp(`recall this layout to ${MACHINE_ID}\\?`, 'i') });
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByRole('button', { name: /^recall$/i }).click();

  const banner = panel.getByRole('status');
  await expect(banner).toBeVisible();

  // Halfway through the 30s window.
  await page.clock.fastForward(15_000);
  // Banner still visible — deadline hasn't expired.
  await expect(banner).toBeVisible();

  // Operator clicks "keep" → ackLayout writes + banner dismisses locally.
  await banner.getByRole('button', { name: /^keep$/i }).click();
  await expect(page.getByText('layout kept', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(banner).toBeHidden();

  // Now the load-bearing check: advance PAST the original 30s deadline.
  // If keep correctly disarmed the 250ms deadline setInterval, nothing
  // should happen. If it didn't, the auto-revert toast would fire here.
  await page.clock.fastForward(20_000);

  // Negative assertion — ensure the auto-revert toast does NOT appear.
  // Sonner toasts auto-dismiss after ~4s by default, but we're asserting
  // it was never rendered, which `toHaveCount(0)` checks immediately
  // against the current DOM without waiting for a fresh render.
  await expect(
    page.getByText('no confirmation sent — agent will auto-revert', { exact: true }),
  ).toHaveCount(0);
});
