/**
 * Dispatch — deployment progress. Stubs the agent's per-target writes through
 * downloading → installing → completed and asserts the deployments page
 * tracks each transition. The deployment doc is pre-seeded (create-UI is
 * covered by the create-deployment spec).
 *
 * Rows collapse by default. Badge text is `status.replace('_', ' ')`, and the
 * `{progress}%` line renders only for downloading/installing with a numeric
 * progress.
 */

import { test, expect } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';
import { stubDeploymentTarget } from '../../helpers/stubAgent';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-progress-target';
const DEPLOYMENT_ID = `deploy-${Date.now()}`;
const DEPLOYMENT_NAME = 'E2E Progress Deployment';

async function clearDeploymentsForSite() {
  const db = getAdminDb();
  const col = db.collection('sites').doc(SITE_ID).collection('deployments');
  const snap = await col.get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

async function seedDeployment() {
  const db = getAdminDb();
  await db.collection('sites').doc(SITE_ID).collection('deployments').doc(DEPLOYMENT_ID).set({
    name: DEPLOYMENT_NAME,
    installer_name: 'progress-test.exe',
    installer_url: 'https://example.com/progress-test.exe',
    silent_flags: '/SILENT',
    status: 'in_progress',
    createdAt: Timestamp.now(),
    targets: [
      { machineId: MACHINE_ID, status: 'pending' },
    ],
  });
}

test.beforeEach(async () => {
  await seedMachine(SITE_ID, MACHINE_ID);
  await clearDeploymentsForSite();
  await seedDeployment();
});

test('deployment row reflects downloading → installing → completed transitions as the agent progresses', async ({ page }) => {
  await page.goto('/deployments');
  await expect(page.getByRole('heading', { name: 'deployments', exact: true })).toBeVisible({ timeout: 10_000 });

  // Click the name span; the parent header catches the bubble and expands.
  // Targeting the header itself is ambiguous with the outer card divs.
  await page.getByText(DEPLOYMENT_NAME, { exact: true }).click();

  // Match by rounded class + machineId text, not exact tailwind class strings.
  const targetRow = page
    .locator('div.flex.items-center.justify-between')
    .filter({ hasText: MACHINE_ID })
    .first();
  await expect(targetRow).toBeVisible({ timeout: 5_000 });
  // Initial pending status renders.
  await expect(targetRow.getByText('pending', { exact: true })).toBeVisible();

  // Step 1 — agent reports downloading at 25%.
  await stubDeploymentTarget(SITE_ID, DEPLOYMENT_ID, MACHINE_ID, {
    status: 'downloading',
    progress: 25,
  });
  await expect(targetRow.getByText('downloading', { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect(targetRow.getByText('25%', { exact: true })).toBeVisible();
  // Old status badge is gone.
  await expect(targetRow.getByText('pending', { exact: true })).toHaveCount(0);

  // Step 2 — installing at 70%. The progress label persists across phases.
  await stubDeploymentTarget(SITE_ID, DEPLOYMENT_ID, MACHINE_ID, {
    status: 'installing',
    progress: 70,
  });
  await expect(targetRow.getByText('installing', { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect(targetRow.getByText('70%', { exact: true })).toBeVisible();

  // Step 3 — completed: the cancel button and progress label both disappear.
  await stubDeploymentTarget(SITE_ID, DEPLOYMENT_ID, MACHINE_ID, {
    status: 'completed',
    progress: 100,
  });
  await expect(targetRow.getByText('completed', { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect(targetRow.getByText('100%', { exact: true })).toHaveCount(0);
  // Cancel X button no longer renders for completed targets.
  await expect(targetRow.getByRole('button')).toHaveCount(0);
});
