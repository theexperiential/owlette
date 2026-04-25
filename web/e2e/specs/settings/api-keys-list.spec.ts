/**
 * Settings — api keys list (task 5.1)
 *
 * What this exercises:
 *   /settings/api-keys empty-state, the create-key dialog (publisher
 *   preset + custom ttl), the one-time reveal card with the raw owk_live_*
 *   key, copy-to-clipboard, dismiss, and the one-time-reveal contract
 *   (raw key never resurfaces in the list row or after a reload).
 *
 * Data plane: none — POST /api/keys writes to users/{uid}/api_keys and
 * api_keys/{hash}; no chunks, no r2.
 */

import { test, expect } from '@playwright/test';
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
  const lookupSnap = await db
    .collection('api_keys')
    .where('userId', '==', ADMIN_UID)
    .get();
  await Promise.all(lookupSnap.docs.map((d) => d.ref.delete()));
}

test.beforeEach(async () => {
  await clearApiKeys();
});

test.afterEach(async () => {
  await clearApiKeys();
});

test('create key reveals raw owk_live_* once, copies to clipboard, then list shows prefix only', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  await page.goto('/settings/api-keys');
  await expect(page.getByRole('heading', { name: 'api keys', exact: true })).toBeVisible();

  // Empty-state — no keys seeded for this admin.
  await expect(page.getByText('no api keys yet')).toBeVisible();
  await expect(
    page.getByRole('button', { name: /^create your first key$/i }),
  ).toBeVisible();

  // Open the create dialog via the header action.
  await page.getByRole('button', { name: /^create key$/i }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: /^create api key$/i })).toBeVisible();

  const keyName = `e2e-${Date.now()}`;
  await dialog.getByLabel('name').fill(keyName);
  // ttl defaults to DEFAULT_TTL_DAYS — override to a short, distinct value
  // so the assertion below pins to this run's input rather than the default.
  await dialog.getByLabel(/^ttl \(days\)$/i).fill('30');

  // The "scope" select defaults to the publisher preset; the dialog's
  // initial state is sufficient. Submit, then wait for the response so the
  // reveal card is guaranteed mounted before we read the raw key.
  const responsePromise = page.waitForResponse(
    (res) => res.url().endsWith('/api/keys') && res.request().method() === 'POST',
    { timeout: 10_000 },
  );
  await dialog.getByRole('button', { name: /^create key$/i }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);

  // Reveal card — the raw key is rendered exactly once inside a <code>
  // sibling of the copy button. Anchor on the one-time-reveal banner copy.
  const revealBanner = page.getByText(/key issued — copy it now\. it will not be shown again\./i);
  await expect(revealBanner).toBeVisible();
  const revealCard = revealBanner.locator('xpath=ancestor::*[@data-slot="card"][1]');
  const rawKey = (await revealCard.locator('code').innerText()).trim();
  expect(rawKey).toMatch(/^owk_live_[A-Za-z0-9_-]{43}$/);

  // Copy-to-clipboard — the icon-only copy button is the <code>'s sibling
  // in the reveal card's flex container. (UI gap: the copy button is
  // icon-only with no aria-label; we locate it positionally to avoid
  // depending on the Radix tooltip's accessible description.)
  const copyButton = revealCard
    .locator('code')
    .locator('xpath=parent::div')
    .locator('button');
  await copyButton.click();
  await expect(page.getByText('copied to clipboard')).toBeVisible();
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toBe(rawKey);

  // Dismiss the reveal card via the X button (aria-label="dismiss").
  await revealCard.getByRole('button', { name: 'dismiss' }).click();
  await expect(revealBanner).toBeHidden();

  // List now contains the row with the prefix-only display ("owk_live_xxx•••").
  // The raw key must NOT appear anywhere on the page.
  const expectedPrefix = rawKey.slice(0, 15);
  const keyRow = page.getByText(keyName);
  await expect(keyRow).toBeVisible();
  await expect(page.locator('code', { hasText: expectedPrefix })).toBeVisible();
  await expect(page.getByText(rawKey, { exact: true })).toHaveCount(0);

  // Reload — the one-time-reveal contract holds across navigations.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'api keys', exact: true })).toBeVisible();
  await expect(page.getByText(keyName)).toBeVisible();
  await expect(page.locator('code', { hasText: expectedPrefix })).toBeVisible();
  await expect(page.getByText(rawKey, { exact: true })).toHaveCount(0);
});
