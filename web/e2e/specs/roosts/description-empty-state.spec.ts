/**
 * Roosts — version description empty-state + null-transition (task 3.2)
 *
 * Asserts the "(no description)" placeholder render path on a version with
 * description=null, click-to-edit → save (null → set), and clear → blur
 * (set → null) round-trips. Empty/whitespace normalises to `description: null`
 * (VersionRow.tsx:148; route.ts:224-225 defensively re-applies).
 *
 * Data plane: none — no push, no chunks, no /api/chunks calls.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine, seedRoostWithVersionHistory } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-descempty-machine';
const ROOST_ID = 'rst_test_descempty_001';
const VERSION_ID = `vrs_${ROOST_ID}_v1`;

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
  await seedMachine(SITE_ID, MACHINE_ID);
  // versionCount=1 with description=null mirrors currentVersionDescription=null
  // onto the parent roost — same end-state as a manual seedRoost+seedVersion+update.
  await seedRoostWithVersionHistory(SITE_ID, ROOST_ID, {
    versionCount: 1,
    descriptions: [null],
  });
});

test.afterEach(async () => {
  await cleanup();
});

test('description placeholder renders, edits round-trip null → set → null', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (e) => pageErrors.push(e));

  await page.goto('/roosts');
  await expect(page.getByRole('heading', { name: 'roosts', exact: true })).toBeVisible({ timeout: 10_000 });

  await page.locator(`[data-roost-row="${ROOST_ID}"]`).click();
  await expect(page.getByRole('button', { name: 'version history' })).toBeVisible();

  // Walk from the `#1` cell up to the VersionRow wrapper (flex items-center gap-3).
  const row = page
    .locator('span.font-mono', { hasText: '#1' })
    .locator('xpath=ancestor::div[contains(@class, "items-center") and contains(@class, "gap-3")][1]');
  await expect(row).toBeVisible();

  /* ----- Case A — placeholder renders in muted italic ----- */
  const placeholder = row.getByText('(no description)', { exact: true });
  await expect(placeholder).toBeVisible();
  await expect(placeholder).toHaveClass(/text-muted-foreground/);
  await expect(placeholder).toHaveClass(/italic/);

  /* ----- Case B — null → set transition ----- */
  await row.getByRole('button', { name: 'edit description' }).click();
  const textarea = row.locator('textarea');
  await expect(textarea).toBeVisible();
  await expect(textarea).toBeFocused();
  await expect(textarea).toHaveValue('');

  await textarea.fill('added intro graphic');

  // ControlOrMeta+Enter — works on both Windows runners and mac dev.
  const setResponsePromise = page.waitForResponse(
    (res) =>
      res.url().includes(`/api/roosts/${ROOST_ID}/versions/${VERSION_ID}`) &&
      res.request().method() === 'PATCH',
    { timeout: 10_000 },
  );
  await textarea.press('ControlOrMeta+Enter');
  const setResponse = await setResponsePromise;
  expect(setResponse.status()).toBe(200);
  expect(setResponse.request().postDataJSON()).toMatchObject({
    siteId: SITE_ID,
    description: 'added intro graphic',
  });

  await expect(row).toContainText('added intro graphic');
  await expect(row.getByText('(no description)', { exact: true })).toHaveCount(0);

  /* ----- Case C — set → null transition (clear + blur) ----- */
  await row.getByRole('button', { name: 'edit description' }).click();
  const textarea2 = row.locator('textarea');
  await expect(textarea2).toBeVisible();
  await expect(textarea2).toHaveValue('added intro graphic');

  await textarea2.fill('');
  await expect(textarea2).toHaveValue('');

  // Blur triggers saveDescription → empty draft normalises to `description: null`.
  const clearResponsePromise = page.waitForResponse(
    (res) =>
      res.url().includes(`/api/roosts/${ROOST_ID}/versions/${VERSION_ID}`) &&
      res.request().method() === 'PATCH',
    { timeout: 10_000 },
  );
  await textarea2.blur();
  const clearResponse = await clearResponsePromise;
  expect(clearResponse.status()).toBe(200);
  expect(clearResponse.request().postDataJSON()).toEqual({
    siteId: SITE_ID,
    description: null,
  });

  await expect(row.getByText('(no description)', { exact: true })).toBeVisible();

  expect(pageErrors, `pageerror events: ${pageErrors.map((e) => e.message).join(' | ')}`).toHaveLength(0);
});
