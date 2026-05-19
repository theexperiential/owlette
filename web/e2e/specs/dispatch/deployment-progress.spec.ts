/**
 * Dispatch — deployment progress (D4.2)
 *
 * Stubs the agent's per-target progress writes through the
 * downloading → installing → completed lifecycle and asserts the
 * dashboard's deployments page reflects each transition.
 *
 * Setup pre-seeds a deployment doc directly (skipping the create-UI
 * flow which D4.1 already covers) — keeps this spec focused on the
 * progress-render contract.
 *
 * UI specifics:
 *   - Each deployment row collapses by default; clicking expands to
 *     show targets. Spec expands first, then asserts on target rows.
 *   - Status badge text is `target.status.replace('_', ' ')` so a
 *     'closing_processes' status renders as "closing processes".
 *   - The `{progress}%` line only renders when status is 'downloading'
 *     or 'installing' AND progress is a number.
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

  // The deployment name renders as a span inside the clickable header
  // (`flex items-center justify-between px-4 py-3 hover:bg-muted/50`).
  // Click the name itself — the parent div catches the bubble and toggles
  // expansion. Avoids ambiguity with outer card divs.
  await page.getByText(DEPLOYMENT_NAME, { exact: true }).click();

  // Per-target row uses `border-border/40 bg-background/50` styling — match
  // by the rounded class plus the machineId text content rather than
  // chasing exact tailwind class strings.
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

  // Step 3 — completed. Cancel button + progress label both go away
  // (the `{status === 'pending' || downloading || installing || closing_processes}`
  // gate at app/deployments/page.tsx:225 controls cancel rendering;
  // progress only renders for downloading/installing).
  await stubDeploymentTarget(SITE_ID, DEPLOYMENT_ID, MACHINE_ID, {
    status: 'completed',
    progress: 100,
  });
  await expect(targetRow.getByText('completed', { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect(targetRow.getByText('100%', { exact: true })).toHaveCount(0);
  // Cancel X button no longer renders for completed targets.
  await expect(targetRow.getByRole('button')).toHaveCount(0);
});
