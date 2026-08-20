/**
 * Roosts — end-to-end rollback: three-dot menu → confirm →
 * POST /api/roosts/{id}/rollback → firestore pointer flip → badge re-render.
 * No data plane (no push, chunks or r2).
 *
 * Written against the contract in
 * `dev/active/roost-version-rename/reference/rename-map.md` §2/§7/§8 before the
 * route existed — compiles standalone, passes once the route lands.
 */
import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedRoostWithVersionHistory } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const ROOST_ID = 'rst_test_rollback_001';

async function cleanup() {
  const db = getAdminDb();
  const versions = await db
    .collection('sites').doc(SITE_ID)
    .collection('roosts').doc(ROOST_ID)
    .collection('versions').get();
  await Promise.all(versions.docs.map((d) => d.ref.delete()));
  await db.collection('sites').doc(SITE_ID).collection('roosts').doc(ROOST_ID).delete();
}

test.beforeEach(async () => {
  await cleanup();
  await seedRoostWithVersionHistory(SITE_ID, ROOST_ID, { versionCount: 5 });
});

test.afterEach(async () => {
  await cleanup();
});

test('admin rolls back from v5 to v3 — POST body, firestore pointer, and UI all flip', async ({ page }) => {
  await page.goto('/roosts');
  await expect(page.getByRole('heading', { name: 'roosts', exact: true })).toBeVisible({ timeout: 10_000 });

  const rowButton = page.locator(`button[data-roost-row="${ROOST_ID}"]`);
  await expect(rowButton).toBeVisible();
  const row = rowButton.locator('..');
  await expect(row.getByLabel('current version v5')).toHaveText('v5');

  await rowButton.click();
  await expect(page.getByRole('button', { name: 'version history' })).toBeVisible();

  const v3Row = page.locator('[data-testid="roost-version-row"][data-version-number="3"]');
  await expect(v3Row).toHaveCount(1);

  await v3Row.getByRole('button', { name: 'version actions' }).click();
  await page.getByRole('menuitem', { name: /rollback to this version/i }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/^rollback\?$/)).toBeVisible();
  await expect(dialog).toContainText('#3');
  await expect(dialog).toContainText(/10 seconds/i);
  const confirmBtn = dialog.getByRole('button', { name: /^rollback$/i });
  await expect(confirmBtn).toBeVisible();

  // Must be armed before the click.
  const responsePromise = page.waitForResponse(
    (res) =>
      res.url().includes(`/api/roosts/${ROOST_ID}/rollback`) &&
      res.request().method() === 'POST',
    { timeout: 10_000 },
  );
  await confirmBtn.click();
  const response = await responsePromise;
  expect([200, 202]).toContain(response.status());

  const body = response.request().postDataJSON() as Record<string, unknown>;
  expect(body).toMatchObject({ siteId: SITE_ID, targetVersion: 3 });

  // previousVersionId becomes the was-current v5.
  await expect.poll(
    async () => {
      const snap = await getAdminDb()
        .collection('sites').doc(SITE_ID)
        .collection('roosts').doc(ROOST_ID).get();
      return snap.data()?.currentVersionId;
    },
    { timeout: 5_000, intervals: [100, 250, 500] },
  ).toBe(`vrs_${ROOST_ID}_v3`);

  await expect.poll(
    async () => {
      const snap = await getAdminDb()
        .collection('sites').doc(SITE_ID)
        .collection('roosts').doc(ROOST_ID).get();
      return snap.data()?.previousVersionId;
    },
    { timeout: 5_000, intervals: [100, 250, 500] },
  ).toBe(`vrs_${ROOST_ID}_v5`);

  await expect.poll(
    async () => {
      const badge = row.locator('[aria-label^="current version"]');
      return (await badge.count()) > 0 ? badge.getAttribute('aria-label') : null;
    },
    { timeout: 5_000 },
  ).toBe('current version v3');

  // The current-version dot moves to v3's row.
  const v5Row = page.locator('[data-testid="roost-version-row"][data-version-number="5"]');
  await expect.poll(
    async () => v3Row.getByLabel('current version').count(),
    { timeout: 5_000 },
  ).toBe(1);
  await expect.poll(
    async () => v5Row.getByLabel('current version').count(),
    { timeout: 5_000 },
  ).toBe(0);
});
