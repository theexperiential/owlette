/**
 * Admin — webhooks page (C3.2)
 *
 * The webhooks page reads from `sites/{siteId}/webhooks` via an onSnapshot
 * listener (see `useWebhooks` in WebhookSettingsDialog.tsx). Each test
 * seeds data under a dedicated `site-webhook-tests` site so the tests
 * don't mutate shared baseline state and so reruns are deterministic.
 *
 * Covered:
 *   - list rendering — a seeded webhook appears with name, URL, and the
 *     "never triggered" status badge
 *   - create flow — "add webhook" → fills name/URL/events → "create
 *     webhook" → secret dialog shown + Admin SDK verifies Firestore
 *     doc exists with the expected shape (https URL, enabled=true,
 *     non-empty secret, events array)
 *   - edit flow — pencil → dialog → new URL → "save changes" → toast +
 *     Admin SDK verifies the updated URL
 *   - delete flow — trash → inline "confirm"/"cancel" → confirm → toast
 *     + row gone + Admin SDK confirms doc deleted
 *
 * Not covered: test-send (hits real HTTP — flaky in E2E) and webhook
 * disable/enable toggle (lower-value UI toggle — defer if time permits
 * in a future pass).
 */

import { test, expect, type Page } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedSite } from '../../helpers/seed';

test.use(roleState('superadmin'));

const SITE_ID = 'site-webhook-tests';
const SITE_NAME = 'Z Webhook Test Site';

const SEEDED_WEBHOOK = {
  name: 'seeded webhook',
  url: 'https://example.com/seeded-hook',
  events: ['machine.offline', 'process.crashed'],
};

async function clearWebhooks() {
  const db = getAdminDb();
  const col = db.collection('sites').doc(SITE_ID).collection('webhooks');
  const snap = await col.get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

test.beforeEach(async () => {
  await seedSite({ id: SITE_ID, name: SITE_NAME, owner: 'someone-else', timezone: 'UTC' });
  await clearWebhooks();
});

async function seedWebhook(name = SEEDED_WEBHOOK.name, url = SEEDED_WEBHOOK.url) {
  const db = getAdminDb();
  const ref = db.collection('sites').doc(SITE_ID).collection('webhooks').doc();
  await ref.set({
    name,
    url,
    events: SEEDED_WEBHOOK.events,
    enabled: true,
    secret: 'deadbeef'.repeat(8),
    createdAt: Timestamp.now(),
    createdBy: 'super-uid',
    lastTriggered: null,
    lastStatus: 0,
    failCount: 0,
  });
  return ref.id;
}

async function gotoWebhooksForSeededSite(page: Page) {
  await page.goto('/admin/webhooks');
  // Superadmin sees many sites, so the selector is always rendered. Click it
  // and pick our seeded site by its deterministic name.
  await expect(page.getByRole('heading', { name: 'webhooks', exact: true })).toBeVisible();
  const siteSelect = page.getByRole('combobox');
  await siteSelect.click();
  await page.getByRole('option', { name: SITE_NAME, exact: true }).click();
  // Wait for the dropdown to close before asserting on the list.
  await expect(page.getByRole('combobox')).toContainText(SITE_NAME);
}

test('lists seeded webhooks with name, URL, and status badge', async ({ page }) => {
  await seedWebhook();
  await gotoWebhooksForSeededSite(page);

  const row = page.locator('div.rounded-lg.border').filter({ hasText: SEEDED_WEBHOOK.name });
  await expect(row).toBeVisible();
  await expect(row).toContainText(SEEDED_WEBHOOK.url);
  // Never-triggered status: the yet-unused webhook shows "never triggered".
  await expect(row.getByText('never triggered', { exact: true })).toBeVisible();
});

test('creating a webhook writes Firestore doc and shows the signing secret', async ({ page }) => {
  await gotoWebhooksForSeededSite(page);

  await page.getByRole('button', { name: /add webhook/i }).click();

  const addDialog = page.getByRole('dialog', { name: /^add webhook$/i });
  await expect(addDialog).toBeVisible();

  const newName = 'E2E Created Webhook';
  const newUrl = 'https://example.com/new-e2e-hook';

  await addDialog.getByLabel('name').fill(newName);
  await addDialog.getByLabel(/URL/).fill(newUrl);
  // Pre-seeded events (machine.offline + process.crashed) are already checked
  // per the default state — leave as-is.

  await addDialog.getByRole('button', { name: /^create webhook$/i }).click();

  // Toast fires + the generated-secret dialog opens.
  await expect(page.getByText(/webhook created/i).first()).toBeVisible();
  const secretDialog = page.getByRole('dialog', { name: /^webhook created$/i });
  await expect(secretDialog).toBeVisible();
  // The secret is a 64-char hex string (32 random bytes).
  await expect(secretDialog.locator('code')).toHaveText(/^[0-9a-f]{64}$/);
  await secretDialog.getByRole('button', { name: /^done$/i }).click();

  // Admin SDK read-through — verify the doc shape.
  const db = getAdminDb();
  const snap = await db.collection('sites').doc(SITE_ID).collection('webhooks').get();
  const matching = snap.docs.find((d) => d.data().name === newName);
  expect(matching).toBeDefined();
  const data = matching!.data();
  expect(data.url).toBe(newUrl);
  expect(data.enabled).toBe(true);
  expect(data.events).toEqual(expect.arrayContaining(['machine.offline', 'process.crashed']));
  expect(typeof data.secret).toBe('string');
  expect(data.secret.length).toBeGreaterThan(32);
});

test('editing a webhook updates the Firestore URL', async ({ page }) => {
  const webhookId = await seedWebhook();
  await gotoWebhooksForSeededSite(page);

  const row = page.locator('div.rounded-lg.border').filter({ hasText: SEEDED_WEBHOOK.name });
  // The pencil button has no accessible name; target it by its lucide-react
  // SVG class (`.lucide-pencil`). Same approach for trash below.
  await row.locator('button:has(svg.lucide-pencil)').click();

  const editDialog = page.getByRole('dialog', { name: /^edit webhook$/i });
  await expect(editDialog).toBeVisible();

  const newUrl = 'https://example.com/edited-e2e-hook';
  const urlInput = editDialog.getByLabel(/URL/);
  await urlInput.fill(newUrl);

  await editDialog.getByRole('button', { name: /save changes/i }).click();
  await expect(page.getByText(/webhook updated/i)).toBeVisible();

  // Admin SDK read-through.
  const db = getAdminDb();
  const snap = await db.collection('sites').doc(SITE_ID).collection('webhooks').doc(webhookId).get();
  expect(snap.data()!.url).toBe(newUrl);
});

test('deleting a webhook removes the Firestore doc', async ({ page }) => {
  const webhookId = await seedWebhook('to-be-deleted', 'https://example.com/byebye');
  await gotoWebhooksForSeededSite(page);

  const row = page.locator('div.rounded-lg.border').filter({ hasText: 'to-be-deleted' });
  await expect(row).toBeVisible();

  // Trash icon → inline "confirm" / "cancel" replaces the trash.
  await row.locator('button:has(svg.lucide-trash-2)').click();
  await row.getByRole('button', { name: /^confirm$/i }).click();

  await expect(page.getByText(/webhook deleted/i)).toBeVisible();

  // Admin SDK verifies the doc is gone.
  const db = getAdminDb();
  const snap = await db.collection('sites').doc(SITE_ID).collection('webhooks').doc(webhookId).get();
  expect(snap.exists).toBe(false);
});
