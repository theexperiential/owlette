/**
 * Dispatch — create project distribution / roost (D5.1)
 *
 * Flow mirrors D4.1 (create deployment) but targets the roost surface:
 *   1. Seed a machine on site-A.
 *   2. UI: /roosts → "new roost" → ProjectDistributionDialog ("roost a
 *      project") → fill distribution name + project URL → check target
 *      machine → "distribute to 1 machine".
 *   3. Firestore (per useProjectDistributions.createDistribution):
 *      - `sites/{siteId}/project_distributions/project-dist-{ts}` doc with
 *        `{ name, file_name (auto-extracted from URL path), project_url,
 *           targets, createdAt, status }`. Status flips pending →
 *        in_progress once all per-machine commands write.
 *      - One `distribute_{distId}_{machineId}_{ts}` command per target in
 *        `sites/{siteId}/machines/{id}/commands/pending` with
 *        `{ type: 'distribute_project', project_url, project_name,
 *           distribution_id, status: 'pending' }`.
 *
 * Admin role — roost creation is a site-admin action.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';
import { getPendingCommandIds } from '../../helpers/stubAgent';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-roost-target';

async function clearRoostAndCommands() {
  const db = getAdminDb();
  await Promise.all([
    db.collection('sites').doc(SITE_ID).collection('project_distributions').get().then((s) =>
      Promise.all(s.docs.map((d) => d.ref.delete())),
    ),
    db.collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID).collection('commands').get().then((s) =>
      Promise.all(s.docs.map((d) => d.ref.delete())),
    ),
  ]);
}

test.beforeEach(async () => {
  await seedMachine(SITE_ID, MACHINE_ID);
  await clearRoostAndCommands();
});

test('admin creates a roost distribution — project_distributions doc + per-target distribute_project command both written', async ({ page }) => {
  const distributionName = `E2E Roost ${Date.now()}`;
  const projectUrl = `https://example.com/test-project-${Date.now()}.zip`;

  await page.goto('/roosts');
  await expect(page.getByRole('heading', { name: 'roosts', exact: true })).toBeVisible({ timeout: 10_000 });

  // Open the dialog. "new roost" button appears in the header and the empty
  // state — first() tolerates both without a deployments-list-loaded race.
  await page.getByRole('button', { name: /^new roost$/i }).first().click();

  const dialog = page.getByRole('dialog', { name: /^roost a project$/i });
  await expect(dialog).toBeVisible();

  // activeMode='deploy' by default. sourceMode flipped to 'upload' in
  // 7b04ad9 ("upload-first dialog UX"), so switch to the 'by url'
  // radio before filling #project-url — the input only renders when
  // sourceMode === 'url'.
  await dialog.locator('#distribution-name').fill(distributionName);
  await dialog.getByRole('radio', { name: /^by url$/i }).click();
  await dialog.locator('#project-url').fill(projectUrl);

  // Select the seeded machine row.
  const machineRow = dialog.locator('div').filter({ hasText: new RegExp(`^${MACHINE_ID}`) }).first();
  await machineRow.click();

  await dialog.getByRole('button', { name: /^distribute to 1 machine$/i }).click();

  // Toast — singular form when one machine.
  await expect(page.getByText(`roost started — syncing to 1 machine`, { exact: true })).toBeVisible({ timeout: 10_000 });

  // Admin SDK — the distribution doc exists.
  const db = getAdminDb();
  let distDocs: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  await expect.poll(async () => {
    const snap = await db.collection('sites').doc(SITE_ID).collection('project_distributions').get();
    distDocs = snap.docs;
    return distDocs.length;
  }, { timeout: 10_000 }).toBe(1);

  const doc = distDocs[0];
  const dist = doc.data();
  expect(doc.id).toMatch(/^project-dist-\d+$/);
  expect(dist.name).toBe(distributionName);
  expect(dist.project_url).toBe(projectUrl);
  // file_name is auto-extracted from the URL's last path segment.
  expect(dist.file_name).toMatch(/^test-project-\d+\.zip$/);
  expect(['pending', 'in_progress']).toContain(dist.status);
  expect(Array.isArray(dist.targets)).toBe(true);
  expect(dist.targets).toHaveLength(1);
  expect(dist.targets[0].machineId).toBe(MACHINE_ID);
  expect(dist.targets[0].status).toBe('pending');

  // Command landed in the target machine's pending doc.
  const pendingIds = await getPendingCommandIds(SITE_ID, MACHINE_ID);
  const distributeKeys = pendingIds.filter((id) => id.startsWith('distribute_'));
  expect(distributeKeys).toHaveLength(1);

  const pendingSnap = await db
    .collection('sites').doc(SITE_ID)
    .collection('machines').doc(MACHINE_ID)
    .collection('commands').doc('pending').get();
  const cmd = pendingSnap.data()![distributeKeys[0]];
  expect(cmd.type).toBe('distribute_project');
  expect(cmd.distribution_id).toBe(doc.id);
  expect(cmd.project_url).toBe(projectUrl);
  // Agent reads `project_name` from the command payload — maps to file_name.
  expect(cmd.project_name).toMatch(/^test-project-\d+\.zip$/);
  expect(cmd.status).toBe('pending');
});
