/**
 * Roosts — rollback flow (task 2.3)
 *
 * what this exercises:
 *   end-to-end rollback from the version-history three-dot menu — UI
 *   confirm flow → POST /api/roosts/{id}/rollback → firestore pointer
 *   flip → list-row badge + current-version marker re-render.
 *
 * data plane: none — no push, no chunks, no r2.
 *
 * NOTE: as of this spec being authored, the rollback route at
 * `web/app/api/roosts/[roostId]/rollback/route.ts` is not yet
 * implemented. VersionRow already POSTs to the path. This spec is
 * authored against the contract documented in
 * `dev/active/roost-version-rename/reference/rename-map.md` §2 + §7
 * (body shape `{ siteId, targetVersion: <number|id|alias> }`, transactional
 * pointer flip per §8). Spec compiles standalone; runtime will pass once
 * the route lands.
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

  // Pre-condition — list row shows current version v5.
  const rowButton = page.locator(`button[data-roost-row="${ROOST_ID}"]`);
  await expect(rowButton).toBeVisible();
  const row = rowButton.locator('..');
  await expect(row.getByLabel('current version v5')).toHaveText('v5');

  // Expand the panel.
  await rowButton.click();
  await expect(page.getByRole('heading', { name: 'version history' })).toBeVisible();

  // Resilient: pick the row whose `#N` cell renders `#3`.
  const v3Row = page
    .locator('div.flex.items-start.gap-3')
    .filter({ has: page.getByText('#3', { exact: true }) });
  await expect(v3Row).toHaveCount(1);

  // Open v3's three-dot menu + click rollback.
  await v3Row.getByRole('button', { name: 'version actions' }).click();
  await page.getByRole('menuitem', { name: /rollback to this version/i }).click();

  // ConfirmDialog opens. Title "rollback?", description mentions "#3" and
  // "10 seconds", confirm button labelled "rollback".
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/^rollback\?$/)).toBeVisible();
  await expect(dialog).toContainText('#3');
  await expect(dialog).toContainText(/10 seconds/i);
  const confirmBtn = dialog.getByRole('button', { name: /^rollback$/i });
  await expect(confirmBtn).toBeVisible();

  // Capture the POST before clicking confirm.
  const responsePromise = page.waitForResponse(
    (res) =>
      res.url().includes(`/api/roosts/${ROOST_ID}/rollback`) &&
      res.request().method() === 'POST',
    { timeout: 10_000 },
  );
  await confirmBtn.click();
  const response = await responsePromise;
  // Route returns 200 on success (rename-map §10 + standard route convention).
  expect([200, 202]).toContain(response.status());

  const body = response.request().postDataJSON() as Record<string, unknown>;
  expect(body).toMatchObject({ siteId: SITE_ID, targetVersion: 3 });

  // Firestore — pointer flipped to v3, previous bumped to v5 (was-current).
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

  // UI — list-row badge re-renders to v3.
  await expect.poll(
    async () => {
      const badge = row.locator('[aria-label^="current version"]');
      return (await badge.count()) > 0 ? badge.getAttribute('aria-label') : null;
    },
    { timeout: 5_000 },
  ).toBe('current version v3');

  // Expanded VersionHistory — current-version dot now lives on v3's row, not v5.
  const v5Row = page
    .locator('div.flex.items-start.gap-3')
    .filter({ has: page.getByText('#5', { exact: true }) });
  await expect.poll(
    async () => v3Row.getByLabel('current version').count(),
    { timeout: 5_000 },
  ).toBe(1);
  await expect.poll(
    async () => v5Row.getByLabel('current version').count(),
    { timeout: 5_000 },
  ).toBe(0);
});
