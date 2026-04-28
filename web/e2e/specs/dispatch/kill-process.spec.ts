/**
 * Dispatch — kill process (D2.3)
 *
 * First spec to consume D1.1's `completeCommand` stub. Flow:
 *   1. Seed a machine with one running process in `metrics.processes`.
 *   2. UI: open dashboard, expand the process panel, click the kill
 *      button on the process row.
 *   3. Firestore: useFirestore.killProcess writes a `kill_{Date.now()}`
 *      command to `commands/pending` with
 *      `{ type: 'kill_process', process_name, status: 'pending' }`.
 *   4. Stub the agent finishing — `completeCommand(...)` writes
 *      `commands/completed` and removes from pending.
 *   5. Stub the next metrics scan — remove the process key from
 *      `metrics.processes` so the machine listener sees it gone.
 *   6. Assert the row disappears from the UI.
 *
 * Admin role (the kill button is disabled for non-RUNNING processes
 * and isn't behind a separate isSiteAdmin gate, but the dashboard's
 * machine view is). MachineCardView is the default; testing the kill
 * affordance there proves the contract for both card and list views
 * since they share the same handler.
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
  // Re-seed the machine doc with one running process under metrics.processes.
  // seedMachine writes minimal metrics, so we extend it via a follow-up set
  // with merge to add the process entry without clobbering the rest.
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
  // Simulate the next metrics scan after the agent killed the process —
  // overwrite metrics.processes with an empty object (mergeFields would also
  // work, but a clean overwrite is closer to what the agent's metrics push
  // looks like in practice).
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

  // Click the kill affordance — aria-label "kill notepad.exe" was added
  // alongside this spec for both card + list views (a11y fix + selector).
  // The Square button OPENS a confirmation dialog rather than firing the
  // kill directly — the actual setDoc only fires on the confirm button.
  await card.getByRole('button', { name: `kill ${PROCESS_NAME}` }).click();

  const confirmDialog = page.getByRole('dialog', { name: /^kill process$/i });
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog).toContainText(PROCESS_NAME);
  await confirmDialog.getByRole('button', { name: /^kill process$/i }).click();

  // useFirestore.killProcess returns immediately after setDoc resolves —
  // no toast on the happy path (only logger.debug). Wait for the command
  // doc to land via Admin SDK polling: the write happens fast but isn't
  // synchronously observable from page.click() returning.
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

  // Simulate the agent: mark the command completed, then push a metrics
  // scan that no longer lists the killed process.
  await completeCommand(SITE_ID, MACHINE_ID, killCmdId, { killed: true }, { cmdType: 'kill_process' });
  await removeProcessFromMetrics();

  // UI: the process row disappears once the snapshot listener picks up
  // the new metrics with the empty processes map.
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
