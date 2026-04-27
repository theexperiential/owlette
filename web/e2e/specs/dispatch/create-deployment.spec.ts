/**
 * Dispatch — create deployment (D4.1)
 *
 * Flow:
 *   1. Seed a machine on site-A.
 *   2. UI: navigate to /deployments → "new deployment" → DeploymentDialog
 *      ("deploy software") → fill installer URL (auto-derives installer
 *      filename) → check the target machine → "deploy to 1 machine".
 *   3. Firestore (per useDeployments.createDeployment):
 *      - `sites/{siteId}/deployments/{deployId}` doc with
 *        `{ name, installer_name, installer_url, silent_flags, targets,
 *           status, createdAt }`. Status starts 'pending', flips to
 *        'in_progress' once all per-machine commands write.
 *      - One `install_{deployId}_{machineId}_{ts}` command per target in
 *        `sites/{siteId}/machines/{id}/commands/pending` with
 *        `{ type: 'install_software', installer_url, deployment_id, … }`.
 *
 * Admin role — deployment creation is a site-admin action.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';
import { getPendingCommandIds } from '../../helpers/stubAgent';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-deploy-target';

async function clearMachineCommands() {
  const db = getAdminDb();
  const col = db.collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID).collection('commands');
  const snap = await col.get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

async function clearDeploymentsForSite() {
  const db = getAdminDb();
  const col = db.collection('sites').doc(SITE_ID).collection('deployments');
  const snap = await col.get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

test.beforeEach(async () => {
  await seedMachine(SITE_ID, MACHINE_ID);
  await clearMachineCommands();
  await clearDeploymentsForSite();
});

test('admin creates a deployment — deployment doc + per-target install command both written', async ({ page }) => {
  await page.goto('/deployments');

  // Wait for the deployments page to mount with our site selected.
  // The page uses an h2 (not h1) for its title.
  await expect(page.getByRole('heading', { name: 'deployments', exact: true })).toBeVisible({ timeout: 10_000 });

  // Open the deploy dialog. The "new deployment" button appears either in the
  // empty state or the header — first() tolerates both.
  await page.getByRole('button', { name: /^new deployment$/i }).first().click();

  const dialog = page.getByRole('dialog', { name: /^deploy software$/i });
  await expect(dialog).toBeVisible();

  // Fill the installer URL — onChange auto-derives installer_name from
  // the URL's last path segment when it includes a dot.
  const installerUrl = `https://example.com/test-installer-${Date.now()}.exe`;
  await dialog.locator('#installer-url').fill(installerUrl);

  // Check the seeded machine in the target list. Each row is a clickable div
  // with the machineId as its visible text + a checkbox; clicking the row
  // toggles the checkbox via toggleMachine.
  const machineRow = dialog.locator('div').filter({ hasText: new RegExp(`^${MACHINE_ID}`) }).first();
  await machineRow.click();

  // Submit. Button text varies with selectedMachines.size:
  // "deploy to 1 machine" / "deploy to N machines".
  await dialog.getByRole('button', { name: /^deploy to 1 machine$/i }).click();

  // Wait until the deployments collection sees the new doc — useDeployments
  // returns immediately after the deploy chain resolves; the resulting
  // dialog close + list refresh are async UI updates.
  const db = getAdminDb();
  let deploymentDocs: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  await expect.poll(async () => {
    const snap = await db.collection('sites').doc(SITE_ID).collection('deployments').get();
    deploymentDocs = snap.docs;
    return deploymentDocs.length;
  }, { timeout: 10_000 }).toBe(1);

  const deployment = deploymentDocs[0].data();
  const deploymentId = deploymentDocs[0].id;
  expect(deploymentId).toMatch(/^deploy-\d+$/);
  expect(deployment.installer_url).toBe(installerUrl);
  expect(deployment.installer_name).toMatch(/^test-installer-\d+\.exe$/);
  // Status: 'in_progress' once the per-machine commands have all landed.
  expect(['pending', 'in_progress']).toContain(deployment.status);
  expect(Array.isArray(deployment.targets)).toBe(true);
  expect(deployment.targets).toHaveLength(1);
  expect(deployment.targets[0].machineId).toBe(MACHINE_ID);
  expect(deployment.targets[0].status).toBe('pending');

  // The install command landed in the target machine's pending doc with the
  // right type + deployment_id linkage.
  let installKeys: string[] = [];
  await expect.poll(async () => {
    const pendingIds = await getPendingCommandIds(SITE_ID, MACHINE_ID);
    installKeys = pendingIds.filter((id) => id.startsWith('install_'));
    return installKeys.length;
  }, { timeout: 10_000 }).toBe(1);

  const pendingSnap = await db
    .collection('sites').doc(SITE_ID)
    .collection('machines').doc(MACHINE_ID)
    .collection('commands').doc('pending').get();
  const cmd = pendingSnap.data()![installKeys[0]];
  expect(cmd.type).toBe('install_software');
  expect(cmd.deployment_id).toBe(deploymentId);
  expect(cmd.installer_url).toBe(installerUrl);
  expect(cmd.status).toBe('pending');
});
