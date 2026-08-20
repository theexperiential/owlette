/**
 * Dispatch — kill process. Seed a running process, click kill, assert the
 * `kill_process` command lands in `commands/pending`, then stub the agent
 * (`completeCommand` + a metrics scan without the process) and assert the row
 * disappears.
 *
 * Admin role because the dashboard machine view is admin-gated, not the kill
 * button. Card and list views share the handler, so card covers both.
 */

import { test, expect } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';
import { completeCommand, getPendingCommandIds } from '../../helpers/stubAgent';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-kill-target';
const PROCESS_ID = 'notepad-12345';
const PROCESS_NAME = 'notepad.exe';

async function clearMachineCommands() {
  const db = getAdminDb();
  const col = db.collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID).collection('commands');
  const snap = await col.get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

async function seedProcessOnMachine() {
  // seedMachine writes minimal metrics, so merge the process entry in rather
  // than clobbering the rest.
  const db = getAdminDb();
  await db.collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID).set(
    {
      metrics: {
        schemaVersion: 2,
        timestamp: Timestamp.now(),
        processes: {
          [PROCESS_ID]: {
            name: PROCESS_NAME,
            status: 'RUNNING',
            pid: 12345,
            cpu_percent: 1.5,
            memory_mb: 32,
          },
        },
      },
    },
    { merge: true },
  );
}

async function removeProcessFromMetrics() {
  // Next metrics scan after the kill. A clean overwrite mirrors the agent's
  // real metrics push more closely than mergeFields.
  const db = getAdminDb();
  await db.collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID).set(
    {
      metrics: {
        schemaVersion: 2,
        timestamp: Timestamp.now(),
        processes: {},
      },
    },
    { merge: true },
  );
}

test.beforeEach(async () => {
  await seedMachine(SITE_ID, MACHINE_ID);
  await clearMachineCommands();
  await seedProcessOnMachine();
});

test('admin kills a process — command dispatched + stubbed completion + process disappears', async ({ page }) => {
  await page.goto('/dashboard');

  // Scope to the seeded machine card and confirm the process row renders.
  const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
  await expect(card).toBeVisible();
  await expect(card.getByText(PROCESS_NAME, { exact: false })).toBeVisible({ timeout: 5_000 });

  // The Square button opens a confirmation dialog; setDoc only fires on confirm.
  await card.getByRole('button', { name: `kill ${PROCESS_NAME}` }).click();

  const confirmDialog = page.getByRole('dialog', { name: /^kill process$/i });
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog).toContainText(PROCESS_NAME);
  await confirmDialog.getByRole('button', { name: /^kill process$/i }).click();

  // No toast on the happy path, and the write is not observable from
  // page.click() returning — poll for the command doc via the Admin SDK.
  const db = getAdminDb();
  let pending: FirebaseFirestore.DocumentData = {};
  await expect.poll(async () => {
    const snap = await db
      .collection('sites').doc(SITE_ID)
      .collection('machines').doc(MACHINE_ID)
      .collection('commands').doc('pending').get();
    pending = snap.data() ?? {};
    return Object.keys(pending).filter((id) => pending[id]?.type === 'kill_process').length;
  }, { timeout: 5_000 }).toBe(1);

  const killCmdId = Object.keys(pending).find((id) => pending[id]?.type === 'kill_process')!;

  // Verify the command's shape.
  expect(killCmdId).toMatch(/^cmd_/);
  const cmd = pending[killCmdId];
  expect(cmd.type).toBe('kill_process');
  expect(cmd.process_name).toBe(PROCESS_NAME);
  expect(cmd.process_id).toBe(PROCESS_ID);
  expect(cmd.status).toBe('pending');

  // Agent stub: complete the command, then push metrics without the process.
  await completeCommand(SITE_ID, MACHINE_ID, killCmdId, { killed: true }, { cmdType: 'kill_process' });
  await removeProcessFromMetrics();

  // The row goes once the snapshot listener sees the empty processes map.
  await expect(card.getByText(PROCESS_NAME, { exact: false })).toHaveCount(0, { timeout: 5_000 });

  // Admin SDK: pending no longer has the kill command, completed has it.
  const pendingAfter = await getPendingCommandIds(SITE_ID, MACHINE_ID);
  expect(pendingAfter).not.toContain(killCmdId);

  const completedSnap = await db
    .collection('sites').doc(SITE_ID)
    .collection('machines').doc(MACHINE_ID)
    .collection('commands').doc('completed').get();
  expect(completedSnap.data()![killCmdId].status).toBe('completed');
});
