/**
 * Roosts — create-roost dialog: name validation, and POST /api/roosts writing
 * the empty-shell doc that useRoosts renders reactively. No version push.
 *
 * UI GAP: nothing in the dashboard calls `POST /api/roosts` today — the upload
 * pipeline only hits `/api/roosts/{id}/versions`, which writes the roost as a
 * side effect of publishing v1. The second case therefore drives the endpoint
 * from the browser's authenticated session. Revisit if the modal grows a
 * "save without publishing" path.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine, TEST_SITES, TEST_USERS } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = TEST_SITES[0].id; // site-A
const MACHINE_ID = 'e2e-create-roost-target';

async function cleanupRoosts(): Promise<void> {
  const db = getAdminDb();
  const snap = await db.collection('sites').doc(SITE_ID).collection('roosts').get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

test.beforeEach(async () => {
  await seedMachine(SITE_ID, MACHINE_ID);
  await cleanupRoosts();
});

test.afterEach(async () => {
  await cleanupRoosts();
});

test('submit stays disabled until the roost name is non-empty', async ({ page }) => {
  await page.goto('/roosts');
  await expect(page.getByRole('heading', { name: 'roosts', exact: true })).toBeVisible();

  await page.getByRole('button', { name: /^new roost$/i }).first().click();

  const dialog = page.getByRole('dialog', { name: /^new roost$/i });
  await expect(dialog).toBeVisible();

  const nameInput = dialog.locator('#distribution-name');
  // The accessible name varies with the selected-machine count.
  const submit = dialog.getByRole('button', { name: /^upload and distribute to \d+ machines?$/i });

  // Empty: disabled, and no inline error until the user types then clears.
  await expect(nameInput).toHaveValue('');
  await expect(submit).toBeDisabled();
  await expect(dialog.getByText('roost name is required')).toBeHidden();

  // Whitespace-only: non-empty but trim() === '', so the error does fire.
  await nameInput.fill(' ');
  await expect(submit).toBeDisabled();
  await expect(dialog.getByText('roost name is required')).toBeVisible();
  await expect(nameInput).toHaveAttribute('aria-invalid', 'true');

  // Still disabled: the dialog also gates on a target machine and a dropped
  // folder, both covered by separate specs.
  await nameInput.fill('test-roost-name-only');
  await expect(dialog.getByText('roost name is required')).toBeHidden();
  await expect(nameInput).toHaveAttribute('aria-invalid', 'false');
});

test('POST /api/roosts creates an empty roost shell and the dashboard refreshes', async ({ page }) => {
  await page.goto('/roosts');
  await expect(page.getByRole('heading', { name: 'roosts', exact: true })).toBeVisible();

  const roostName = `test-roost-${Date.now()}`;

  // Direct call — see the UI GAP note at the top.
  const responsePromise = page.waitForResponse(
    (res) =>
      res.url().endsWith('/api/roosts') && res.request().method() === 'POST',
    { timeout: 10_000 },
  );
  const result = await page.evaluate(
    async ({ siteId, name, machineId }) => {
      const res = await fetch('/api/roosts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId, name, targets: [machineId] }),
      });
      return { status: res.status, body: await res.json() };
    },
    { siteId: SITE_ID, name: roostName, machineId: MACHINE_ID },
  );
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  expect(result.status).toBe(201);
  const newRoostId = result.body.roostId as string;
  expect(newRoostId).toMatch(/^rst_[a-f0-9]{18}$/);

  // The empty-shell contract from web/app/api/roosts/route.ts.
  const db = getAdminDb();
  const snap = await db
    .collection('sites').doc(SITE_ID).collection('roosts').doc(newRoostId).get();
  expect(snap.exists).toBe(true);
  const data = snap.data()!;
  expect(data.schemaVersion).toBe(2);
  expect(data.name).toBe(roostName);
  expect(data.targets).toEqual([MACHINE_ID]);
  expect(data.versionCounter ?? 0).toBe(0);
  expect(data.currentVersionId ?? null).toBeNull();
  expect(data.createdBy).toBe(TEST_USERS.admin.uid);

  // useRoosts onSnapshot materializes the row.
  const newRow = page.locator(`[data-roost-row="${newRoostId}"]`);
  await expect(newRow).toContainText(roostName);
  // No version published, so no version badge.
  await expect(newRow.locator('[aria-label^="current version"]')).toHaveCount(0);
});
