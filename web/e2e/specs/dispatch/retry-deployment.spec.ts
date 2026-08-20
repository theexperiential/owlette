/**
 * Dispatch — retry failed deployment.
 *
 * "Retry failed" retries IN PLACE via POST
 * /api/sites/{siteId}/deployments/{deploymentId}/retry — it no longer clones a
 * "(Retry)" deployment. The SAME doc flips to 'in_progress', the failed target
 * resets to 'pending' with its error dropped and `retriedAt` stamped, and one
 * new install_software command (retry_attempt: true) lands in commands/pending
 * carrying the deployment's sha256_checksum.
 *
 * Both entry points share the flow: the row dropdown (all failed targets) and
 * the per-target retry icon (body `machines` filter). The seed carries a
 * sha256_checksum so the server's legacy self-heal (which would fetch the
 * installer URL) stays out of the loop — deterministic in the emulator.
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
const SHA256 = 'ab'.repeat(32);

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
    sha256_checksum: SHA256,
    status: 'failed',
    createdAt: Timestamp.now(),
    targets: [
      { machineId: MACHINE_ID, status: 'failed', error: 'install exited with code 1603' },
    ],
  });
}

async function assertInPlaceRetry() {
  const db = getAdminDb();

  // Same doc mutated — no "(Retry)" clone is ever created.
  let targets: Array<{ status: string; error?: string; retriedAt?: unknown }> = [];
  await expect.poll(async () => {
    const snap = await db.collection('sites').doc(SITE_ID).collection('deployments').doc(DEPLOYMENT_ID).get();
    targets = (snap.data()!.targets ?? []) as typeof targets;
    return `${snap.data()!.status}:${targets[0]?.status}`;
  }, { timeout: 10_000 }).toBe('in_progress:pending');

  expect(targets[0].error).toBeUndefined();
  expect(targets[0].retriedAt).toBeDefined();

  const allDeploys = await db.collection('sites').doc(SITE_ID).collection('deployments').get();
  expect(allDeploys.docs).toHaveLength(1);

  // New install command tied to the ORIGINAL deployment id, checksum intact.
  const pendingIds = await getPendingCommandIds(SITE_ID, MACHINE_ID);
  const installKeys = pendingIds.filter((id) => id.startsWith('install_'));
  expect(installKeys).toHaveLength(1);

  const pendingSnap = await db
    .collection('sites').doc(SITE_ID)
    .collection('machines').doc(MACHINE_ID)
    .collection('commands').doc('pending').get();
  const cmd = pendingSnap.data()![installKeys[0]];
  expect(cmd.type).toBe('install_software');
  expect(cmd.deployment_id).toBe(DEPLOYMENT_ID);
  expect(cmd.installer_url).toBe(INSTALLER_URL);
  expect(cmd.sha256_checksum).toBe(SHA256);
  expect(cmd.retry_attempt).toBe(true);
}

test.beforeEach(async () => {
  await seedMachine(SITE_ID, MACHINE_ID);
  await clearDeploymentsAndCommands();
  await seedFailedDeployment();
});

test('admin retries a failed deployment in place via the row dropdown', async ({ page }) => {
  await page.goto('/deployments');
  await expect(page.getByRole('heading', { name: 'deployments', exact: true })).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: `deployment actions for ${DEPLOYMENT_NAME}` }).click();
  await page.getByRole('menuitem', { name: /retry failed/i }).click();

  await expect(page.getByText('retrying deployment for 1 machine(s)', { exact: true }))
    .toBeVisible({ timeout: 10_000 });

  await assertInPlaceRetry();
});

test('admin retries a single failed target via the per-row retry icon', async ({ page }) => {
  await page.goto('/deployments');
  await expect(page.getByRole('heading', { name: 'deployments', exact: true })).toBeVisible({ timeout: 10_000 });

  // Expand the deployment row to reveal per-target rows.
  await page.getByText(DEPLOYMENT_NAME, { exact: true }).click();
  await page.getByRole('button', { name: `retry deployment to ${MACHINE_ID}` }).click();

  await expect(page.getByText('retrying deployment for 1 machine(s)', { exact: true }))
    .toBeVisible({ timeout: 10_000 });

  await assertInPlaceRetry();
});
