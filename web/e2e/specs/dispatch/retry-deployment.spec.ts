/**
 * Dispatch — retry failed deployment (D4.4)
 *
 * "Retry failed" doesn't mutate the original deployment — per
 * `app/deployments/page.tsx::handleRetryDeployment`, it filters the
 * deployment's targets to those with status='failed', then calls
 * `createDeployment` with name `${original.name} (Retry)` targeting
 * just those machines. End-state:
 *   - Original deployment unchanged (still has the failed target).
 *   - A NEW deployment doc exists with the retry name + the failed
 *     target as its sole target (status: 'pending').
 *   - One install_software command for that machine in commands/pending.
 *
 * Closes wave D4 (deployment dispatch).
 */

import { test, expect } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';
import { getPendingCommandIds } from '../../helpers/stubAgent';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-retry-deploy-target';
const DEPLOYMENT_ID = `deploy-${Date.now()}`;
const DEPLOYMENT_NAME = 'E2E Retry Deployment';
const INSTALLER_NAME = 'retry-test.exe';
const INSTALLER_URL = `https://example.com/${INSTALLER_NAME}`;

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

async function seedFailedDeployment() {
  const db = getAdminDb();
  await db.collection('sites').doc(SITE_ID).collection('deployments').doc(DEPLOYMENT_ID).set({
    name: DEPLOYMENT_NAME,
    installer_name: INSTALLER_NAME,
    installer_url: INSTALLER_URL,
    silent_flags: '/SILENT',
    status: 'failed',
    createdAt: Timestamp.now(),
    targets: [
      { machineId: MACHINE_ID, status: 'failed', error: 'install exited with code 1603' },
    ],
  });
}

test.beforeEach(async () => {
  await seedMachine(SITE_ID, MACHINE_ID);
  await clearDeploymentsAndCommands();
  await seedFailedDeployment();
});

test('admin retries a failed deployment — original untouched + new "(Retry)" deployment + new install command', async ({ page }) => {
  await page.goto('/deployments');
  await expect(page.getByRole('heading', { name: 'deployments', exact: true })).toBeVisible({ timeout: 10_000 });

  // Open the deployment's actions dropdown — aria-label was added
  // alongside this spec for a11y (icon-only MoreVertical button).
  await page.getByRole('button', { name: `deployment actions for ${DEPLOYMENT_NAME}` }).click();

  // The "retry failed" item is gated to deployments with at least one
  // failed target — our seed satisfies that.
  await page.getByRole('menuitem', { name: /retry failed/i }).click();

  // Toast — the singular form for one machine.
  await expect(page.getByText('retrying deployment for 1 failed machine(s)', { exact: true }))
    .toBeVisible({ timeout: 10_000 });

  // Admin SDK: a NEW deployment exists with the (Retry) suffix.
  const db = getAdminDb();
  let retryDeploys: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  await expect.poll(async () => {
    const snap = await db.collection('sites').doc(SITE_ID).collection('deployments').get();
    retryDeploys = snap.docs.filter((d) => d.data().name === `${DEPLOYMENT_NAME} (Retry)`);
    return retryDeploys.length;
  }, { timeout: 5_000 }).toBe(1);

  const retryDoc = retryDeploys[0];
  const retryData = retryDoc.data();
  expect(retryDoc.id).toMatch(/^deploy-\d+$/);
  expect(retryDoc.id).not.toBe(DEPLOYMENT_ID);
  expect(retryData.installer_url).toBe(INSTALLER_URL);
  expect(retryData.installer_name).toBe(INSTALLER_NAME);
  expect(retryData.targets).toHaveLength(1);
  expect(retryData.targets[0].machineId).toBe(MACHINE_ID);
  expect(retryData.targets[0].status).toBe('pending');
  // No 'error' field carries over — fresh start for the retry.
  expect(retryData.targets[0].error).toBeUndefined();

  // Original deployment is unchanged.
  const originalSnap = await db.collection('sites').doc(SITE_ID).collection('deployments').doc(DEPLOYMENT_ID).get();
  const originalTargets = originalSnap.data()!.targets as Array<{ status: string; error?: string }>;
  expect(originalTargets[0].status).toBe('failed');
  expect(originalTargets[0].error).toBe('install exited with code 1603');

  // A new install_software command landed in pending tied to the new
  // retry deployment id.
  const pendingIds = await getPendingCommandIds(SITE_ID, MACHINE_ID);
  const installKeys = pendingIds.filter((id) => id.startsWith('install_'));
  expect(installKeys).toHaveLength(1);

  const pendingSnap = await db
    .collection('sites').doc(SITE_ID)
    .collection('machines').doc(MACHINE_ID)
    .collection('commands').doc('pending').get();
  const cmd = pendingSnap.data()![installKeys[0]];
  expect(cmd.type).toBe('install_software');
  expect(cmd.deployment_id).toBe(retryDoc.id);
  expect(cmd.installer_url).toBe(INSTALLER_URL);
});
