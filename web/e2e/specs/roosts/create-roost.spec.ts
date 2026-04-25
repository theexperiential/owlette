/**
 * Roosts — create-roost dialog (task 1.1).
 *
 * Exercises (a) name validation in the new-roost dialog (empty +
 * whitespace-only keep submit disabled and surface the inline error)
 * and (b) POST /api/roosts writes the empty-shell roost doc with the
 * documented shape, dashboard reactively renders the new row via
 * useRoosts onSnapshot.
 *
 * data plane: none — empty shell, no version push.
 *
 * NOTE — UI gap: the dialog's submit gates on name + folder + target,
 * and the dashboard does NOT call `POST /api/roosts` today — the
 * upload pipeline at web/lib/roostUpload.ts only hits
 * `/api/roosts/{id}/versions`, which writes the roost as a side effect
 * of publishing v1. Test case B therefore drives `POST /api/roosts`
 * directly from the browser's authenticated session. Update once the
 * modal grows a "save without publishing" path.
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
  // Submit's accessible name varies by selected-machine count.
  const submit = dialog.getByRole('button', { name: /^distribute to \d+ machines?$/i });

  // Empty name → disabled, no inline error (error only renders once the
  // user has typed and then cleared back to whitespace).
  await expect(nameInput).toHaveValue('');
  await expect(submit).toBeDisabled();
  await expect(dialog.getByText('roost name is required')).toBeHidden();

  // Whitespace-only → still disabled, AND inline error fires because the
  // value is non-empty but trim() === ''. aria-invalid flips to true.
  await nameInput.fill(' ');
  await expect(submit).toBeDisabled();
  await expect(dialog.getByText('roost name is required')).toBeVisible();
  await expect(nameInput).toHaveAttribute('aria-invalid', 'true');

  // Real name clears the inline error. Submit remains disabled because
  // the dialog also gates on a target machine + dropped folder, but
  // those gates live in separate specs (new-version / upload-gated).
  await nameInput.fill('test-roost-name-only');
  await expect(dialog.getByText('roost name is required')).toBeHidden();
  await expect(nameInput).toHaveAttribute('aria-invalid', 'false');
});

test('POST /api/roosts creates an empty roost shell and the dashboard refreshes', async ({ page }) => {
  await page.goto('/roosts');
  await expect(page.getByRole('heading', { name: 'roosts', exact: true })).toBeVisible();

  const roostName = `test-roost-${Date.now()}`;

  // Drive POST /api/roosts from the browser's authenticated session — see
  // the spec's leading NOTE on why we don't go through the dialog submit.
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

  // Firestore shape — the empty-shell contract from web/app/api/roosts/route.ts.
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

  // Dashboard reacts via useRoosts onSnapshot — the new row materializes.
  const newRow = page.locator(`[data-roost-row="${newRoostId}"]`);
  await expect(newRow).toContainText(roostName);
  // No version published → version badge is absent.
  await expect(newRow.locator('[aria-label^="current version"]')).toHaveCount(0);
});
