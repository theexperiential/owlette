/**
 * Time-travel — apply + ack BEFORE deadline. Inverse of E2.1: the
 * operator-keeps-layout path against a fake clock partway into the 30s window.
 *
 * Dispatch restore → banner with deadline t+30s → fastForward 15s (banner still
 * up) → click "keep" → fastForward past 30s.
 *
 * That last step is the point: D3.4 already proves keep works, this proves keep
 * DISARMS the deadline watchdog. A regression that dismissed the banner but
 * left the setInterval running shows up only here.
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
  const confirmDialog = page.getByRole('dialog', { name: new RegExp(`restore this layout to ${MACHINE_ID}\\?`, 'i') });
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByRole('button', { name: /^restore$/i }).click();

  // DisplayLayoutPanel has two role="status" nodes — the ack banner and the
  // loading spinner — and a restore dispatch can re-flip `loading` mid-tick, so
  // a bare getByRole('status') trips strict mode. Scope by the banner text.
  const banner = panel.getByRole('status').filter({ hasText: /keep this layout/i });
  await expect(banner).toBeVisible();

  // Halfway through the 30s window.
  await page.clock.fastForward(15_000);
  // Banner still visible — deadline hasn't expired.
  await expect(banner).toBeVisible();

  // Operator clicks "keep" → ackLayout writes + banner dismisses locally.
  await banner.getByRole('button', { name: /^keep$/i }).click();
  await expect(page.getByText('ack sent', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(banner).toBeHidden();

  // Load-bearing: past the original 30s deadline. If keep disarmed the 250ms
  // deadline setInterval nothing happens; otherwise the auto-revert toast fires.
  await page.clock.fastForward(20_000);

  // toHaveCount(0) checks the current DOM immediately, so sonner's ~4s
  // auto-dismiss can't mask a toast that was actually rendered.
  await expect(
    page.getByText('no confirmation sent — agent will auto-revert', { exact: true }),
  ).toHaveCount(0);
});
