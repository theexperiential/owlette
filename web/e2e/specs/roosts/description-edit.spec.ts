/**
 * Roosts — the click-to-edit version description inside VersionRow: blur saves,
 * Ctrl/⌘+Enter saves without blur, Escape cancels with no PATCH, and a saved
 * description survives a reload.
 *
 * PATCH /api/roosts/{roostId}/versions/{versionId} — `{ siteId, description }`.
 */
import { test, expect, type Page } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine, seedRoostWithVersionHistory } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-descedit-machine';
const ROOST_ID = 'rst_test_descedit_001';
// Mirrors seedRoostWithVersionHistory's deterministic id stamp.
const versionIdFor = (n: number) => `vrs_${ROOST_ID}_v${n}`;

async function cleanup() {
  const db = getAdminDb();
  const versions = await db
    .collection('sites').doc(SITE_ID)
    .collection('roosts').doc(ROOST_ID)
    .collection('versions').get();
  await Promise.all(versions.docs.map((d) => d.ref.delete()));
  await db.collection('sites').doc(SITE_ID).collection('roosts').doc(ROOST_ID).delete();
}

const rowFor = (page: Page, n: number) =>
  page.locator(`[data-testid="roost-version-row"][data-version-number="${n}"]`);

async function expandRoost(page: Page) {
  await page.goto('/roosts');
  await expect(page.getByRole('heading', { name: 'roosts', exact: true })).toBeVisible({ timeout: 10_000 });
  await ensureRoostExpanded(page);
}

async function ensureRoostExpanded(page: Page) {
  const row = page.locator(`[data-roost-row="${ROOST_ID}"]`);
  await expect(row).toBeVisible();
  const historyToggle = page.getByRole('button', { name: 'version history' });
  if ((await row.getAttribute('aria-expanded')) !== 'true') {
    await row.click();
  }
  await expect(historyToggle).toBeVisible();
  // The panel renders a denormalized current-version fallback while
  // GET /versions loads; v2 only exists in the real history list.
  await expect(rowFor(page, 2)).toBeVisible();
}

const waitPatch = (page: Page, n: number) =>
  page.waitForResponse(
    (res) =>
      res.url().includes(`/api/roosts/${ROOST_ID}/versions/${versionIdFor(n)}`) &&
      res.request().method() === 'PATCH',
    { timeout: 10_000 },
  );

function trackErrors(page: Page) {
  const errs: Error[] = [];
  page.on('pageerror', (e) => errs.push(e));
  return () => expect(errs, `pageerror events: ${errs.map((e) => e.message).join(' | ')}`).toHaveLength(0);
}

test.beforeEach(async () => {
  await cleanup();
  await seedMachine(SITE_ID, MACHINE_ID);
  await seedRoostWithVersionHistory(SITE_ID, ROOST_ID, {
    versionCount: 3,
    descriptions: [null, 'v2 work', 'initial'],
  });
});

test.afterEach(async () => {
  await cleanup();
});

test('A — blur saves the edited description and the row re-renders', async ({ page }) => {
  const assertNoPageErrors = trackErrors(page);
  await expandRoost(page);

  const v3 = rowFor(page, 3);
  await v3.getByRole('button', { name: 'edit description' }).click();

  const editor = v3.locator('textarea');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue('initial');
  await editor.fill('initial + fixed video');

  const responsePromise = waitPatch(page, 3);
  await page.getByRole('heading', { name: 'roosts', exact: true }).click();

  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toMatchObject({
    siteId: SITE_ID,
    description: 'initial + fixed video',
  });

  await expect(v3.getByRole('button', { name: 'edit description' }))
    .toContainText('initial + fixed video');

  assertNoPageErrors();
});

test('B — ⌘+Enter saves without a blur', async ({ page }) => {
  const assertNoPageErrors = trackErrors(page);
  await expandRoost(page);

  const v2 = rowFor(page, 2);
  await v2.getByRole('button', { name: 'edit description' }).click();
  const editor = v2.locator('textarea');
  await expect(editor).toBeFocused();
  await editor.fill('v2 work — keyboard save');

  const responsePromise = waitPatch(page, 2);
  // VersionRow checks metaKey || ctrlKey, so Control+Enter is portable.
  await editor.press('Control+Enter');

  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toMatchObject({
    siteId: SITE_ID,
    description: 'v2 work — keyboard save',
  });

  await expect(v2.locator('textarea')).toHaveCount(0);
  await expect(v2.getByRole('button', { name: 'edit description' }))
    .toContainText('v2 work — keyboard save');

  assertNoPageErrors();
});

test('C — Escape cancels, no PATCH fires, UI reverts', async ({ page }) => {
  const assertNoPageErrors = trackErrors(page);
  await expandRoost(page);

  // Assert no PATCH fires after Esc.
  const patchUrls: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'PATCH' && req.url().includes(`/api/roosts/${ROOST_ID}/versions/`)) {
      patchUrls.push(req.url());
    }
  });

  const v2 = rowFor(page, 2);
  await v2.getByRole('button', { name: 'edit description' }).click();
  const editor = v2.locator('textarea');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue('v2 work');
  await editor.fill('v2 work — abandoned edit');

  await editor.press('Escape');

  await expect(v2.locator('textarea')).toHaveCount(0);
  const restored = v2.getByRole('button', { name: 'edit description' });
  await expect(restored).toContainText('v2 work');
  await expect(restored).not.toContainText('abandoned edit');

  // Give a wrongly-fired PATCH time to land before asserting none did.
  await expect.poll(() => patchUrls.length, { timeout: 1_000 }).toBe(0);

  assertNoPageErrors();
});

test('D — edited description persists across a full page reload', async ({ page }) => {
  const assertNoPageErrors = trackErrors(page);
  await expandRoost(page);

  const v3 = rowFor(page, 3);
  await v3.getByRole('button', { name: 'edit description' }).click();
  const editor = v3.locator('textarea');
  await expect(editor).toBeFocused();
  await editor.fill('initial + fixed video');

  const responsePromise = waitPatch(page, 3);
  await editor.press('Control+Enter');
  expect((await responsePromise).status()).toBe(200);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'roosts', exact: true })).toBeVisible({ timeout: 10_000 });
  await ensureRoostExpanded(page);

  await expect(rowFor(page, 3).getByRole('button', { name: 'edit description' }))
    .toContainText('initial + fixed video');

  assertNoPageErrors();
});
