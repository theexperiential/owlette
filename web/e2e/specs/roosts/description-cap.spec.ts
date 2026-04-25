/**
 * Roosts — description 500-char cap (task 3.3).
 *
 * VersionRow.tsx caps the description via *silent truncation* on every
 * onChange (`setDraft(value.slice(0, 500))`) — there is no inline error
 * and no save-button-disabled state. The server PATCH route also rejects
 * > 500 chars with a 400, but the UI truncates before the request fires.
 *
 * UX gap flagged: typing past the cap is invisible. A char counter
 * (e.g. "500/500") or inline error would be a better signal, mirroring
 * ProjectDistributionDialog.tsx line 855 (`{description.length}/{MAX}`).
 */

import { test, expect, type Page } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine, seedRoostWithVersionHistory } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-desccap-machine';
const ROOST_ID = 'rst_test_desccap_001';
const VERSION_ID = `vrs_${ROOST_ID}_v1`;

async function cleanup() {
  const db = getAdminDb();
  const roostRef = db.collection('sites').doc(SITE_ID).collection('roosts').doc(ROOST_ID);
  const versions = await roostRef.collection('versions').get();
  await Promise.all(versions.docs.map((d) => d.ref.delete()));
  await roostRef.delete();
}

test.beforeEach(async () => {
  await cleanup();
  await seedMachine(SITE_ID, MACHINE_ID);
  await seedRoostWithVersionHistory(SITE_ID, ROOST_ID, {
    versionCount: 1,
    descriptions: ['initial'],
  });
});

test.afterEach(async () => {
  await cleanup();
});

async function openDescriptionEditor(page: Page) {
  await page.goto('/roosts');
  await expect(page.getByRole('heading', { name: 'roosts', exact: true })).toBeVisible({ timeout: 10_000 });
  await page.locator(`[data-roost-row="${ROOST_ID}"]`).click();
  await expect(page.getByRole('heading', { name: 'version history' })).toBeVisible();
  await page.getByRole('button', { name: 'edit description' }).click();
  const textarea = page.locator('textarea[placeholder*="what changed"]');
  await expect(textarea).toBeVisible();
  return textarea;
}

function waitForPatch(page: Page) {
  return page.waitForResponse(
    (res) =>
      res.url().includes(`/api/roosts/${ROOST_ID}/versions/${VERSION_ID}`) &&
      res.request().method() === 'PATCH',
    { timeout: 10_000 },
  );
}

test('501-char input is silently truncated to 500 before PATCH fires', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (e) => pageErrors.push(e));

  const textarea = await openDescriptionEditor(page);
  // The onChange handler truncates to 500, so the textarea never holds 501.
  await textarea.fill('z'.repeat(501));
  await expect(textarea).toHaveValue('z'.repeat(500));

  const patchPromise = waitForPatch(page);
  await textarea.blur();
  const response = await patchPromise;
  expect(response.status()).toBe(200);

  const body = response.request().postDataJSON() as Record<string, unknown>;
  expect(body).toMatchObject({ siteId: SITE_ID, description: 'z'.repeat(500) });

  expect(pageErrors, `pageerror events: ${pageErrors.map((e) => e.message).join(' | ')}`).toHaveLength(0);
});

test('exactly 500 chars accepted — PATCH fires, UI updates', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (e) => pageErrors.push(e));

  const textarea = await openDescriptionEditor(page);
  const exactCap = 'y'.repeat(500);
  await textarea.fill(exactCap);
  await expect(textarea).toHaveValue(exactCap);

  const patchPromise = waitForPatch(page);
  await textarea.blur();
  const response = await patchPromise;
  expect(response.status()).toBe(200);

  const body = response.request().postDataJSON() as Record<string, unknown>;
  expect(body).toMatchObject({ siteId: SITE_ID, description: exactCap });

  // UI re-renders with the saved value once the editor closes.
  await expect(page.getByText(exactCap, { exact: true })).toBeVisible({ timeout: 5_000 });

  expect(pageErrors, `pageerror events: ${pageErrors.map((e) => e.message).join(' | ')}`).toHaveLength(0);
});
