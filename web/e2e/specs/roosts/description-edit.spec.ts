/**
 * Roosts — version description inline-edit (task 3.1)
 *
 * Exercises the click-to-edit description editor inside each VersionRow:
 *   A. blur saves              → PATCH fires + UI updates
 *   B. Ctrl/⌘+Enter saves      → PATCH fires + UI updates (no blur)
 *   C. Escape cancels          → no PATCH, UI text reverts
 *   D. saved description persists across a full page reload
 *
 * Endpoint: PATCH /api/roosts/{roostId}/versions/{versionId}
 *           body: { siteId, description }
 * Data plane: none — no push, no chunks.
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
  // The panel may render a denormalized current-version fallback while
  // GET /versions is still loading. v2 only exists in the real history list.
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

  // v3 description "initial" lives inside a <button aria-label="edit description">.
  const v3 = rowFor(page, 3);
  await v3.getByRole('button', { name: 'edit description' }).click();

  const editor = v3.locator('textarea');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue('initial');
  await editor.fill('initial + fixed video');

  const responsePromise = waitPatch(page, 3);
  // Blur without toggling the version-history section closed.
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
  // VersionRow checks metaKey || ctrlKey — Control+Enter works on every chromium platform.
  await editor.press('Control+Enter');

  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toMatchObject({
    siteId: SITE_ID,
    description: 'v2 work — keyboard save',
  });

  // Editor closes, button re-renders with the new text.
  await expect(v2.locator('textarea')).toHaveCount(0);
  await expect(v2.getByRole('button', { name: 'edit description' }))
    .toContainText('v2 work — keyboard save');

  assertNoPageErrors();
});

test('C — Escape cancels, no PATCH fires, UI reverts', async ({ page }) => {
  const assertNoPageErrors = trackErrors(page);
  await expandRoost(page);

  // Listen for every PATCH at the version endpoint — assert none fire post-Esc.
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

  // Editor unmounts and the static button reappears with the ORIGINAL text.
  await expect(v2.locator('textarea')).toHaveCount(0);
  const restored = v2.getByRole('button', { name: 'edit description' });
  await expect(restored).toContainText('v2 work');
  await expect(restored).not.toContainText('abandoned edit');

  // Give any (incorrectly fired) PATCH a moment to land, then assert none did.
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

  // Reload, re-expand, assert v3 still reads the saved description.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'roosts', exact: true })).toBeVisible({ timeout: 10_000 });
  await ensureRoostExpanded(page);

  await expect(rowFor(page, 3).getByRole('button', { name: 'edit description' }))
    .toContainText('initial + fixed video');

  assertNoPageErrors();
});
