/**
 * Dispatch — cancel pending restart (D2.4)
 *
 * Flow:
 *   1. Seed a machine that's mid-restart (rebootingInSec=120 sets
 *      `rebooting: true` + `rebootScheduledAt: now+120s`).
 *   2. UI: dashboard shows the red cancel-countdown pill instead of the
 *      green online pill (per MachineStatusPill: hasUpcomingRestart is
 *      true while rebootScheduledAt > now).
 *   3. Click the pill → useFirestore.cancelRestart writes a
 *      `cancel_reboot_{ts}` command to `commands/pending`. NOTE:
 *      cancelRestart does NOT directly clear rebootScheduledAt — the
 *      agent does that after consuming the command.
 *   4. Stub the agent: completeCommand for cancel_reboot AND clear
 *      rebootScheduledAt + rebooting on the machine doc (the agent
 *      writes both as one merge).
 *   5. Assert: cancel pill disappears, rebootScheduledAt is null.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';
import { completeCommand, getPendingCommandIds, stubRebootSuccess } from '../../helpers/stubAgent';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-cancel-reboot-target';

async function clearMachineCommands() {
  const db = getAdminDb();
  const col = db.collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID).collection('commands');
  const snap = await col.get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

test.beforeEach(async () => {
  // 120-second future window keeps the cancel pill clickable for the
  // duration of the test (final 5 seconds → text-only, no click handler).
  await seedMachine(SITE_ID, MACHINE_ID, { rebootingInSec: 120 });
  await clearMachineCommands();
});

test('admin cancels an in-flight reboot — cancel command dispatched + agent clears reboot state + pill returns to online', async ({ page }) => {
  await page.goto('/dashboard');

  const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
  await expect(card).toBeVisible();

  // The red cancel-countdown pill renders because rebootScheduledAt > now.
  const cancelPill = card.getByTestId('machine-status-cancel-pill');
  await expect(cancelPill).toBeVisible();
  await cancelPill.click();

  // Wait for the cancel_reboot command to land in pending.
  const db = getAdminDb();
  let pending: FirebaseFirestore.DocumentData = {};
  await expect.poll(async () => {
    const snap = await db
      .collection('sites').doc(SITE_ID)
      .collection('machines').doc(MACHINE_ID)
      .collection('commands').doc('pending').get();
    pending = snap.data() ?? {};
    return Object.keys(pending).filter((id) => pending[id]?.type === 'cancel_reboot').length;
  }, { timeout: 5_000 }).toBe(1);

  const cancelCmdId = Object.keys(pending).find((id) => pending[id]?.type === 'cancel_reboot')!;

  // Verify command shape.
  expect(cancelCmdId).toMatch(/^cmd_/);
  const cmd = pending[cancelCmdId];
  expect(cmd.type).toBe('cancel_reboot');
  expect(cmd.status).toBe('pending');

  // Stub the agent: complete the cancel command + clear the reboot flags
  // (mirrors agent's cancel-handler at owlette_service.py:5489).
  await completeCommand(SITE_ID, MACHINE_ID, cancelCmdId, { cancelled: true }, { cmdType: 'cancel_reboot' });
  await stubRebootSuccess(SITE_ID, MACHINE_ID);

  // UI: cancel pill goes away once the listener picks up rebootScheduledAt: null.
  await expect(cancelPill).toHaveCount(0, { timeout: 5_000 });

  // Admin SDK: machine doc no longer has an active reboot.
  const machineSnap = await db.collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID).get();
  const machineData = machineSnap.data()!;
  expect(machineData.rebootScheduledAt).toBeFalsy();
  expect(machineData.rebooting).toBe(false);

  // commands/pending no longer contains the cancel command; completed has it.
  const pendingAfter = await getPendingCommandIds(SITE_ID, MACHINE_ID);
  expect(pendingAfter).not.toContain(cancelCmdId);
  const completedSnap = await db
    .collection('sites').doc(SITE_ID)
    .collection('machines').doc(MACHINE_ID)
    .collection('commands').doc('completed').get();
  expect(completedSnap.data()![cancelCmdId].status).toBe('completed');
});
