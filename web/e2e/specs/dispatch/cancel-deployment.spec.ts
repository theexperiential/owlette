/**
 * Dispatch — cancel deployment (D4.3)
 *
 * Pre-seeds a deployment with one downloading target, clicks the
 * per-target cancel X, asserts:
 *   - cancel_installation command in commands/pending
 *   - target status flips to 'cancelled' (useDeployments.cancelDeployment
 *     does this synchronously inside the same transaction — no agent
 *     stub needed for THAT transition)
 *   - the cancel-X disappears (gated to active states only)
 * Then stubs the agent finishing the cancel via completeCommand —
 * proves the dispatched cancel command moves through pending → completed
 * cleanly.
 *
 * UI a11y fix shipped with this spec: per-target cancel button gets
 * `aria-label="cancel deployment to {machineId}"` so the icon-only X
 * has a programmatic accessible name.
 */

import { test, expect } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';
import { completeCommand, getPendingCommandIds } from '../../helpers/stubAgent';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-cancel-deploy-target';
const DEPLOYMENT_ID = `deploy-${Date.now()}`;
const DEPLOYMENT_NAME = 'E2E Cancel Deployment';
const INSTALLER_NAME = 'cancel-test.exe';

async function clearDeploymentsAndCommands() {
  const db = getAdminDb();
  await Promise.all([
    db.collection('sites').doc(SITE_ID).collection('deployments').get().then((s) =>
      Promise.all(s.docs.map((d) => d.ref.delete())),
    ),
    db.collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID).collection('commands').get().then((s) =>
      Promise.all(s.docs.map((d) => d.ref.delete())),
    ),
  ]);
}

async function seedActiveDeployment() {
  const db = getAdminDb();
  await db.collection('sites').doc(SITE_ID).collection('deployments').doc(DEPLOYMENT_ID).set({
    name: DEPLOYMENT_NAME,
    installer_name: INSTALLER_NAME,
    installer_url: `https://example.com/${INSTALLER_NAME}`,
    silent_flags: '/SILENT',
    status: 'in_progress',
    createdAt: Timestamp.now(),
    targets: [
      // Downloading is an active state — cancel X renders.
      { machineId: MACHINE_ID, status: 'downloading', progress: 30 },
    ],
  });
}

test.beforeEach(async () => {
  await seedMachine(SITE_ID, MACHINE_ID);
  await clearDeploymentsAndCommands();
  await seedActiveDeployment();
});

test('admin cancels an in-flight deployment target — command dispatched + target flips to cancelled + cancel button gone', async ({ page }) => {
  await page.goto('/deployments');
  await expect(page.getByRole('heading', { name: 'deployments', exact: true })).toBeVisible({ timeout: 10_000 });

  // Expand the row by clicking the deployment name.
  await page.getByText(DEPLOYMENT_NAME, { exact: true }).click();

  const targetRow = page
    .locator('div.flex.items-center.justify-between')
    .filter({ hasText: MACHINE_ID })
    .first();
  await expect(targetRow).toBeVisible();
  await expect(targetRow.getByText('downloading', { exact: true })).toBeVisible();

  // Click the cancel X — aria-label was added alongside this spec for a11y
  // (icon-only buttons need a programmatic name).
  await targetRow.getByRole('button', { name: `cancel deployment to ${MACHINE_ID}` }).click();

  // useDeployments.cancelDeployment flips the target status synchronously
  // inside its transaction (independent of any agent response). UI should
  // reflect that on the next snapshot tick.
  await expect(targetRow.getByText('cancelled', { exact: true })).toBeVisible({ timeout: 5_000 });
  // Cancel X is gone — gated to active states only (page.tsx:225).
  await expect(targetRow.getByRole('button', { name: /cancel deployment to/ })).toHaveCount(0);

  // Firestore: cancel_installation command in pending.
  const pendingIds = await getPendingCommandIds(SITE_ID, MACHINE_ID);
  const cancelKeys = pendingIds.filter((id) => id.startsWith('cancel_'));
  expect(cancelKeys).toHaveLength(1);

  const db = getAdminDb();
  const pendingSnap = await db
    .collection('sites').doc(SITE_ID)
    .collection('machines').doc(MACHINE_ID)
    .collection('commands').doc('pending').get();
  const cmd = pendingSnap.data()![cancelKeys[0]];
  expect(cmd.type).toBe('cancel_installation');
  expect(cmd.deployment_id).toBe(DEPLOYMENT_ID);
  expect(cmd.installer_name).toBe(INSTALLER_NAME);

  // Deployment target's persisted status — Admin SDK confirms the
  // transaction landed (not just an optimistic UI flip).
  const deploySnap = await db.collection('sites').doc(SITE_ID).collection('deployments').doc(DEPLOYMENT_ID).get();
  const targets = deploySnap.data()!.targets as Array<{ machineId: string; status: string; cancelledAt?: unknown }>;
  const cancelledTarget = targets.find((t) => t.machineId === MACHINE_ID)!;
  expect(cancelledTarget.status).toBe('cancelled');
  expect(cancelledTarget.cancelledAt).toBeDefined();

  // Stub the agent finishing the cancel — completes the lifecycle.
  await completeCommand(SITE_ID, MACHINE_ID, cancelKeys[0], { cancelled: true }, { cmdType: 'cancel_installation' });

  const pendingAfter = await getPendingCommandIds(SITE_ID, MACHINE_ID);
  expect(pendingAfter).not.toContain(cancelKeys[0]);
  const completedSnap = await db
    .collection('sites').doc(SITE_ID)
    .collection('machines').doc(MACHINE_ID)
    .collection('commands').doc('completed').get();
  expect(completedSnap.data()![cancelKeys[0]].status).toBe('completed');
});
