/**
 * Dispatch — shutdown flow (D2.2)
 *
 * Same shape as D2.1's reboot spec — different command type
 * (`shutdown_machine`), different schedule field (`shutdownScheduledAt`),
 * same write-pair pattern + cancel-pill UI contract.
 *
 * Contract (from useFirestore.ts::shutdownMachine):
 *   1. `sendMachineCommand` writes `shutdown_machine_{Date.now()}` to
 *      `commands/pending`.
 *   2. `updateDoc` sets `{ shutdownScheduledAt: now+30s, configChangeFlag: true }`
 *      on the machine status doc.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-shutdown-target';

async function clearMachineCommands() {
  const db = getAdminDb();
  const col = db.collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID).collection('commands');
  const snap = await col.get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

test.beforeEach(async () => {
  await seedMachine(SITE_ID, MACHINE_ID);
  await clearMachineCommands();
});

test('admin can dispatch shutdown — command written + shutdownScheduledAt populated + countdown pill renders', async ({ page }) => {
  const before = Math.floor(Date.now() / 1000);

  await page.goto('/dashboard');

  const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
  await expect(card).toBeVisible();
  await card.getByTestId('machine-context-menu-trigger').click();

  const menu = page.getByRole('menu');
  await menu.getByTestId('machine-context-menu-shutdown').click();

  const confirmDialog = page.getByRole('dialog', { name: new RegExp(`shutdown ${MACHINE_ID}\\?`, 'i') });
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByRole('button', { name: /^shutdown$/i }).click();

  // Wait for the dispatch handler to settle — same waiting discipline as
  // D2.1: clicking the confirm button returns immediately while the
  // Promise.all writes are still in flight (button shows "sending..."),
  // so reading Firestore before this toast races the writes.
  await expect(page.getByText('Shutdown command sent to', { exact: false })).toBeVisible({ timeout: 10_000 });

  // UI: cancel-countdown pill renders for shutdownScheduledAt > now too.
  await expect(card.getByTestId('machine-status-cancel-pill')).toBeVisible({ timeout: 5_000 });

  // Admin SDK read-through.
  const db = getAdminDb();
  const machineSnap = await db.collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID).get();
  const machineData = machineSnap.data()!;
  expect(typeof machineData.shutdownScheduledAt).toBe('number');
  expect(machineData.shutdownScheduledAt).toBeGreaterThanOrEqual(before + 25);
  expect(machineData.shutdownScheduledAt).toBeLessThanOrEqual(before + 60);
  expect(machineData.configChangeFlag).toBe(true);
  // rebootScheduledAt MUST stay clear — shutdown isn't a reboot.
  expect(machineData.rebootScheduledAt).toBeFalsy();

  // Pending commands has exactly one shutdown_machine_* entry.
  const pendingSnap = await db
    .collection('sites').doc(SITE_ID)
    .collection('machines').doc(MACHINE_ID)
    .collection('commands').doc('pending').get();
  expect(pendingSnap.exists).toBe(true);
  const pending = pendingSnap.data()!;
  const shutdownKeys = Object.keys(pending).filter((k) => k.startsWith('shutdown_machine_'));
  expect(shutdownKeys).toHaveLength(1);
  const cmd = pending[shutdownKeys[0]];
  expect(cmd.type).toBe('shutdown_machine');
  expect(cmd.status).toBe('pending');
});
