/**
 * Settings — api key scope grid
 *
 * What this exercises:
 *   The always-visible resource x permission matrix that replaced the preset
 *   dropdown + hidden "custom" builder. The old builder had ZERO DOM coverage —
 *   its only protection was the pure-function unit suite — and this change
 *   rewrote all of its markup, so these are the first end-to-end assertions
 *   that the controls a user needs are actually on screen and actually submit.
 *
 *   Covered: checkboxes present at first paint; preset chips write into the
 *   grid rather than replacing it (the scope-loss regression); reaching a
 *   resource no preset covers (installer, which is why this matters — it is
 *   what the publisher key needed to upload an installer binary); the wire
 *   body matching what the grid showed; and editing a live key's scopes in
 *   place via PATCH.
 *
 * SELECTOR HYGIENE — inherit this if you extend the file:
 *   - Scope everything under page.getByRole('main').
 *   - NEVER write a bare page.getByRole('combobox'). This surface has ZERO in
 *     its default state and 1+N once specific rows exist. The repo's house
 *     style (admin/schedules.spec.ts:75, admin/webhooks.spec.ts:85) is a bare
 *     combobox query and it is a trap here — use data-testid="scope-resource-N".
 *   - Radix Checkbox renders a <button>, not a native input, so target it by
 *     its aria-label (precedent: mobile/settings-keys-webhooks.spec.ts:124).
 *   - Never getByText('create key') — ApiKeysManager renders a <Label> with
 *     that exact text, which is harmless for getByRole and fatal for getByText.
 *
 * Data plane: none — POST/PATCH /api/keys write to users/{uid}/api_keys and
 * api_keys/{hash}; no chunks, no r2.
 */

import { test, expect, type Page } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { TEST_USERS } from '../../helpers/seed';

test.use(roleState('admin'));

const ADMIN_UID = TEST_USERS.admin.uid;

async function clearApiKeys() {
  const db = getAdminDb();
  const userKeysSnap = await db
    .collection('users')
    .doc(ADMIN_UID)
    .collection('api_keys')
    .get();
  await Promise.all(userKeysSnap.docs.map((d) => d.ref.delete()));
  const lookupSnap = await db.collection('api_keys').where('userId', '==', ADMIN_UID).get();
  await Promise.all(lookupSnap.docs.map((d) => d.ref.delete()));
}

test.beforeEach(async () => {
  await clearApiKeys();
});

test.afterEach(async () => {
  await clearApiKeys();
});

/** Land on the page and wait out AuthContext hydration, as api-keys-list does. */
async function openApiKeysPage(page: Page) {
  await page.goto('/settings/api-keys');
  await expect(page.getByRole('heading', { name: 'api keys', exact: true })).toBeVisible({
    timeout: 10_000,
  });
}

async function openCreateForm(page: Page) {
  await openApiKeysPage(page);
  await page.getByRole('button', { name: /^create key$/i }).click();
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: /^create api key$/i })).toBeVisible();
  return main;
}

test('the permission checkboxes are on screen at first paint, with no mode to choose', async ({
  page,
}) => {
  const main = await openCreateForm(page);

  // The reported bug: the scope section rendered a dropdown and nothing else.
  await expect(main.getByText('what this key can reach')).toBeVisible();
  await expect(main.getByLabel('all sites — write')).toBeVisible();
  await expect(main.getByLabel('all machines — deploy')).toBeVisible();

  // Resources that NO preset covers are visible without any disclosure.
  await expect(main.getByText('all classic deploys')).toBeVisible();
  await expect(main.getByText('all processes')).toBeVisible();

  // And the dropdown that used to hide them is gone entirely.
  await expect(main.getByRole('combobox')).toHaveCount(0);

  // The publisher default is reflected in the boxes, not just in a label.
  await expect(main.getByLabel('all sites — write')).toHaveAttribute('data-state', 'checked');
  await expect(main.getByLabel('all sites — admin')).toHaveAttribute('data-state', 'unchecked');
});

test('a preset chip writes into the grid instead of replacing it', async ({ page }) => {
  const main = await openCreateForm(page);

  await expect(main.getByRole('button', { name: 'publisher' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await main.getByRole('button', { name: 'operator' }).click();

  // The regression this guards: picking a preset used to swap in a hidden
  // array, losing 14 of 16 grants the moment the user went looking for the
  // checkboxes. The grid must now SHOW what operator granted.
  await expect(main.getByLabel('all machines — rollback')).toHaveAttribute(
    'data-state',
    'checked',
  );
  await expect(main.getByLabel('all roosts — deploy')).toHaveAttribute('data-state', 'checked');
  await expect(main.getByRole('button', { name: 'operator' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Toggling one box drops the chip out of its pressed state rather than
  // silently keeping a preset label over a set that no longer matches it.
  await main.getByLabel('all roosts — admin').click();
  await expect(main.getByRole('button', { name: 'operator' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(main.getByText('custom scope set — no preset matches')).toBeVisible();
});

test('the POST body is exactly what the grid showed', async ({ page }) => {
  const main = await openCreateForm(page);

  const keyName = `e2e-scopes-${Date.now()}`;
  await main.getByLabel('name').fill(keyName);

  // Start from readonly, then add one grant the preset does not include.
  await main.getByRole('button', { name: 'read only' }).click();
  await main.getByLabel('all processes — write').click();

  await expect(main.getByText('5 scopes · 5 grants')).toBeVisible();

  const responsePromise = page.waitForResponse(
    (res) => res.url().endsWith('/api/keys') && res.request().method() === 'POST',
    { timeout: 10_000 },
  );
  await main.getByRole('button', { name: /^create key$/i }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);

  const sent = JSON.parse(response.request().postData() ?? '{}');
  expect(sent.scopes).toEqual([
    { resource: 'roost', id: '*', permissions: ['read'] },
    { resource: 'site', id: '*', permissions: ['read'] },
    { resource: 'machine', id: '*', permissions: ['read'] },
    { resource: 'chat', id: '*', permissions: ['read'] },
    { resource: 'process', id: '*', permissions: ['write'] },
  ]);
});

test('an id-scoped row stays out of the payload until its id is typed', async ({ page }) => {
  const main = await openCreateForm(page);
  await main.getByLabel('name').fill(`e2e-specific-${Date.now()}`);

  await expect(main.getByText('4 scopes · 8 grants')).toBeVisible();

  await main.getByRole('button', { name: /limit to a specific id/i }).click();

  // Adding the row must not move the counter — a half-built row is not a grant.
  await expect(main.getByText('4 scopes · 8 grants')).toBeVisible();

  await main.getByLabel('scope id').fill('site-alpha');
  await expect(main.getByText('5 scopes · 9 grants')).toBeVisible();

  // The resource picker exists only on this row, and is addressed by test id
  // rather than by role — see the hygiene note at the top of this file.
  await expect(main.locator('[data-testid="scope-resource-2"]')).toBeVisible();

  const responsePromise = page.waitForResponse(
    (res) => res.url().endsWith('/api/keys') && res.request().method() === 'POST',
    { timeout: 10_000 },
  );
  await main.getByRole('button', { name: /^create key$/i }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);

  const sent = JSON.parse(response.request().postData() ?? '{}');
  expect(sent.scopes).toContainEqual({
    resource: 'site',
    id: 'site-alpha',
    permissions: ['read'],
  });
});

test('editing a live key rewrites its scopes in place, without reissuing the secret', async ({
  page,
}) => {
  // Create the key through the UI so the row under test is real.
  const main = await openCreateForm(page);
  const keyName = `e2e-edit-${Date.now()}`;
  await main.getByLabel('name').fill(keyName);

  const createResponse = page.waitForResponse(
    (res) => res.url().endsWith('/api/keys') && res.request().method() === 'POST',
    { timeout: 10_000 },
  );
  await main.getByRole('button', { name: /^create key$/i }).click();
  const created = await createResponse;
  expect(created.status()).toBe(200);
  const createdBody = await created.json();
  const keyId: string = createdBody.keyId;

  // Open that row's editor via the sliders affordance.
  const row = main
    .locator('div.rounded-md.border')
    .filter({ has: page.locator('p.font-medium', { hasText: keyName }) })
    .first();
  await row.getByRole('button', { name: 'edit scopes' }).click();

  await expect(main.getByRole('heading', { name: `editing ${keyName}` })).toBeVisible();

  // Widen it, and confirm the editor says what it is about to do before it
  // does it — the operator is mutating a credential already in use.
  await main.getByLabel('all sites — deploy').click();
  await expect(main.getByText('pending changes')).toBeVisible();
  await expect(main.getByText('adds deploy on all sites')).toBeVisible();

  const patchResponse = page.waitForResponse(
    (res) => res.url().includes(`/api/keys/${keyId}`) && res.request().method() === 'PATCH',
    { timeout: 10_000 },
  );
  await main.getByRole('button', { name: /^save changes$/i }).click();
  const patched = await patchResponse;
  expect(patched.status()).toBe(200);

  // The lookup document is the one authorization actually reads — the user
  // subcollection is never consulted on the auth path — so assert on it.
  const db = getAdminDb();
  const lookupSnap = await db.collection('api_keys').where('userId', '==', ADMIN_UID).get();
  const lookup = lookupSnap.docs.map((d) => d.data()).find((d) => d.keyId === keyId);
  expect(lookup).toBeTruthy();
  expect(lookup!.scopes).toContainEqual({
    resource: 'site',
    id: '*',
    permissions: ['read', 'write', 'deploy'],
  });
});

test('a key cannot be saved with nothing granted', async ({ page }) => {
  const main = await openCreateForm(page);
  await main.getByLabel('name').fill(`e2e-empty-${Date.now()}`);

  // Untick everything the publisher default granted.
  for (const resource of ['all roosts', 'all sites', 'all machines', 'all hoot chats']) {
    for (const permission of ['read', 'write']) {
      await main.getByLabel(`${resource} — ${permission}`).click();
    }
  }

  await expect(main.getByText('nothing granted yet — tick at least one box')).toBeVisible();

  await main.getByRole('button', { name: /^create key$/i }).click();
  await expect(page.getByText('add at least one scope')).toBeVisible();
});
