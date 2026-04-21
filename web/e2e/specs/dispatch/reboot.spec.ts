/**
 * Dispatch — reboot flow (D2.1)
 *
 * Per the plan: click reboot → confirm dialog → Firestore command doc
 * written → 30s countdown pill appears. No time-travel here (E1.x
 * covers the tick / lockout / revert behavior).
 *
 * Contract (from useFirestore.ts::rebootMachine):
 *   1. `sendMachineCommand(...)` writes to
 *      `sites/{siteId}/machines/{machineId}/commands/pending` at key
 *      `reboot_machine_{Date.now()}` with
 *      `{ type: 'reboot_machine', status: 'pending', timestamp: serverTimestamp() }`.
 *   2. `updateDoc` on the machine status doc sets
 *      `{ rebootScheduledAt: now+30s (unix seconds), configChangeFlag: true }` —
 *      the configChangeFlag is REQUIRED by firestore.rules for dashboard
 *      writes to pass (silent reject otherwise).
 *
 * Admin role is used because MachineContextMenu's reboot item is
 * `isSiteAdmin`-gated (per B3.2 — a real production bug was fixed
 * there to enforce this). Admin is on site-A.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-reboot-target';

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

test('admin can dispatch reboot — command written + rebootScheduledAt populated + countdown pill renders', async ({ page }) => {
  const before = Math.floor(Date.now() / 1000);

  await page.goto('/dashboard');

  // Open the machine's context menu and pick "reboot machine".
  const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
  await expect(card).toBeVisible();
  await card.getByTestId('machine-context-menu-trigger').click();

  // shadcn DropdownMenuContent portals out — grab it via role.
  const menu = page.getByRole('menu');
  await menu.getByTestId('machine-context-menu-reboot').click();

  // Confirm dialog — title matches `reboot {machineName}?` where machineName
  // defaults to the raw machineId when no displayName is set.
  const confirmDialog = page.getByRole('dialog', { name: new RegExp(`reboot ${MACHINE_ID}\\?`, 'i') });
  await expect(confirmDialog).toBeVisible();

  await confirmDialog.getByRole('button', { name: /^reboot$/i }).click();

  // The confirm dialog stays open with "sending..." state until BOTH
  // Firestore writes in Promise.all resolve. Waiting for it to close is
  // the most reliable signal that the dispatch completed — without it,
  // subsequent Admin SDK reads race ahead of the client writes.
  await expect(page.getByText('Reboot command sent to', { exact: false })).toBeVisible({ timeout: 10_000 });

  // UI: the cancel-countdown pill replaces the healthy status pill once the
  // snapshot listener picks up the write (rebootScheduledAt > now triggers
  // hasUpcomingReboot). admin role renders the cancel variant (has testid);
  // member would render a text-only badge with no testid (covered in B3.2).
  await expect(card.getByTestId('machine-status-cancel-pill')).toBeVisible({ timeout: 5_000 });

  // Admin SDK read-through — both writes happened.
  const db = getAdminDb();
  const machineSnap = await db.collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID).get();
  const machineData = machineSnap.data()!;
  expect(typeof machineData.rebootScheduledAt).toBe('number');
  // rebootScheduledAt = Math.floor(Date.now()/1000) + 30 — allow a few
  // seconds of drift between the client's clock and our test-side `before`.
  expect(machineData.rebootScheduledAt).toBeGreaterThanOrEqual(before + 25);
  expect(machineData.rebootScheduledAt).toBeLessThanOrEqual(before + 60);
  expect(machineData.configChangeFlag).toBe(true);

  // The pending commands doc has exactly one reboot_machine_* entry.
  const pendingSnap = await db
    .collection('sites').doc(SITE_ID)
    .collection('machines').doc(MACHINE_ID)
    .collection('commands').doc('pending').get();
  expect(pendingSnap.exists).toBe(true);
  const pending = pendingSnap.data()!;
  const rebootKeys = Object.keys(pending).filter((k) => k.startsWith('reboot_machine_'));
  expect(rebootKeys).toHaveLength(1);
  const cmd = pending[rebootKeys[0]];
  expect(cmd.type).toBe('reboot_machine');
  expect(cmd.status).toBe('pending');
});
