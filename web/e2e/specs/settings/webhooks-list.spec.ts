/**
 * Settings — webhooks list (task 5.4)
 *
 * What this exercises:
 *   /settings/webhooks empty-state, the create-webhook dialog (url +
 *   3-event subscription + optional description), the one-time reveal
 *   card with the raw whsec_* signing secret, copy-to-clipboard via
 *   navigator.clipboard.readText, dismiss, list refresh with active
 *   badge + per-event badges, and the one-time-reveal contract (secret
 *   never resurfaces in the list row or after a reload).
 *
 * Data plane: none — POST /api/webhooks writes to
 * sites/{siteId}/webhooks/{id}; no chunks, no r2, no outbound dispatch.
 *
 * URL choice: the task brief specifies `https://ci.example.com/hook` but
 * the create endpoint runs `validateWebhookUrl` which does a real
 * `dns.lookup()` — `ci.example.com` is unregistered and yields NXDOMAIN
 * on most resolvers. `example.com` itself (RFC 2606 reserved + IANA-
 * operated public a/aaaa records) is the closest DNS-resolvable
 * substitute and matches the legacy admin/webhooks.spec.ts convention.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { TEST_SITES } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = TEST_SITES[0].id;
const WEBHOOK_URL = 'https://example.com/ci/hook';
const SUBSCRIBED_EVENTS = [
  'version.published',
  'deployment.completed',
  'machine.offline',
] as const;

async function clearWebhooks() {
  const db = getAdminDb();
  const snap = await db
    .collection('sites')
    .doc(SITE_ID)
    .collection('webhooks')
    .get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

test.beforeEach(async () => {
  await clearWebhooks();
});

test.afterEach(async () => {
  await clearWebhooks();
});

test('create webhook reveals whsec_* once, copies to clipboard, then list shows row without secret', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  await page.goto('/settings/webhooks');
  await expect(
    page.getByRole('heading', { name: 'webhooks', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  // Empty-state — no webhooks seeded for this site.
  await expect(page.getByText('no webhooks yet')).toBeVisible();
  await expect(
    page.getByRole('button', { name: /^create your first webhook$/i }),
  ).toBeVisible();

  // Open the create dialog via the header action.
  await page.getByRole('button', { name: /^create webhook$/i }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: /^create webhook$/i })).toBeVisible();

  await dialog.getByLabel('endpoint url').fill(WEBHOOK_URL);
  const description = `e2e ci notifier ${Date.now()}`;
  await dialog.getByLabel(/^description/i).fill(description);

  for (const evt of SUBSCRIBED_EVENTS) {
    // Each event renders as <label><Checkbox /><span>{evt}</span></label>.
    // Radix Checkbox is a button (no native input), so getByRole('checkbox',
    // {name}) is unreliable — click the label, which toggles the wrapped
    // checkbox via the implicit label association.
    await dialog.locator('label', { hasText: evt }).click();
  }

  // Submit + wait for the response so the reveal card is guaranteed
  // mounted before we read the raw secret.
  const responsePromise = page.waitForResponse(
    (res) =>
      res.url().includes('/api/webhooks') &&
      res.url().includes(`siteId=${SITE_ID}`) &&
      res.request().method() === 'POST',
    { timeout: 10_000 },
  );
  await dialog.getByRole('button', { name: /^create webhook$/i }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const responseBody = (await response.json()) as { id: string; signingSecret: string };
  expect(responseBody.signingSecret).toMatch(/^whsec_[0-9a-f]{64}$/);
  const webhookId = responseBody.id;

  // Reveal card — the raw secret is rendered exactly once inside a <code>
  // sibling of the copy button. Anchor on the one-time-reveal banner copy.
  const revealBanner = page.getByText(
    /signing secret issued — copy it now\. it will not be shown again\./i,
  );
  await expect(revealBanner).toBeVisible();
  const revealCard = revealBanner.locator('xpath=ancestor::*[@data-slot="card"][1]');
  const rawSecret = (await revealCard.locator('code').innerText()).trim();
  expect(rawSecret).toBe(responseBody.signingSecret);

  // Copy-to-clipboard — the reveal card has two icon-only buttons: the X
  // (aria-label="dismiss") and the copy button (TooltipTrigger). Match the
  // copy button by excluding the dismiss aria-label.
  const copyButton = revealCard.locator('button:not([aria-label="dismiss"])');
  await copyButton.click();
  await expect(page.getByText('copied to clipboard')).toBeVisible();
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toBe(rawSecret);

  // Dismiss the reveal card via the X button (aria-label="dismiss").
  await revealCard.getByRole('button', { name: 'dismiss' }).click();
  await expect(revealBanner).toBeHidden();

  // List now contains the new webhook card — active badge + per-event
  // badges + url + description. Each WebhookCard is a shadcn Card
  // (`data-slot="card"`); pick the one containing our unique url.
  const row = page
    .locator('[data-slot="card"]')
    .filter({ has: page.locator('code', { hasText: WEBHOOK_URL }) });
  await expect(row).toBeVisible();
  await expect(row.getByText('active', { exact: true })).toBeVisible();
  await expect(row.getByText(description)).toBeVisible();
  for (const evt of SUBSCRIBED_EVENTS) {
    await expect(row.getByText(evt, { exact: true })).toBeVisible();
  }

  // One-time-reveal contract — the raw secret must not appear anywhere on
  // the page now that the reveal card is dismissed.
  await expect(page.getByText(rawSecret, { exact: true })).toHaveCount(0);

  // Firestore shape — the api stored the secret plaintext (intentional —
  // see route.ts) but no other endpoint surfaces it.
  const snap = await getAdminDb()
    .collection('sites')
    .doc(SITE_ID)
    .collection('webhooks')
    .doc(webhookId)
    .get();
  expect(snap.exists).toBe(true);
  const data = snap.data()!;
  expect(data.url).toBe(WEBHOOK_URL);
  expect(data.events).toEqual(expect.arrayContaining([...SUBSCRIBED_EVENTS]));
  expect(data.paused).toBe(false);
  expect(data.signingSecret).toBe(rawSecret);

  // Reload — the one-time-reveal contract holds across navigations.
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'webhooks', exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('code', { hasText: WEBHOOK_URL })).toBeVisible();
  await expect(page.getByText(rawSecret, { exact: true })).toHaveCount(0);
});
