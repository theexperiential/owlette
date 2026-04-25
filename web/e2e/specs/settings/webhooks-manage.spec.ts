/**
 * Settings — webhooks management (task 5.5)
 *
 * Exercises the per-row admin actions on /settings/webhooks against a
 * pre-seeded subscription: pause -> resume -> rotate-secret -> delete.
 * Each step asserts the http call (PATCH/POST/DELETE) fires with the
 * documented shape and that the resulting firestore + ui state lands.
 *
 * UI gap: WebhookCard renders the four actions as inline icon buttons
 * inside Tooltips, not a three-dot menu (task spec asked for one). Each
 * button is targeted by its lucide-react svg class — same pattern as
 * web/e2e/specs/admin/webhooks.spec.ts.
 *
 * data plane: none — no outbound webhook delivery is exercised.
 */

import { test, expect } from '@playwright/test';
import { FieldValue } from 'firebase-admin/firestore';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { TEST_SITES, TEST_USERS } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = TEST_SITES[0].id;
const WEBHOOK_ID = 'wh_e2e_manage_001';
const WEBHOOK_URL = 'https://example.com/e2e-manage-hook';
const WEBHOOK_EVENTS = ['version.published', 'deployment.completed'];
const SEEDED_SECRET = `whsec_${'a'.repeat(64)}`;

interface SeedWebhookOptions {
  url?: string;
  events?: string[];
  description?: string;
  paused?: boolean;
  signingSecret?: string;
}

async function seedWebhook(
  siteId: string,
  webhookId: string,
  opts: SeedWebhookOptions = {},
): Promise<void> {
  const url = opts.url ?? WEBHOOK_URL;
  const hostname = new URL(url).hostname;
  const db = getAdminDb();
  await db
    .collection('sites')
    .doc(siteId)
    .collection('webhooks')
    .doc(webhookId)
    .set({
      schemaVersion: 1,
      url,
      hostname,
      events: opts.events ?? WEBHOOK_EVENTS,
      ...(opts.description ? { description: opts.description } : {}),
      signingSecret: opts.signingSecret ?? SEEDED_SECRET,
      secretRotatedAt: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      createdBy: TEST_USERS.admin.uid,
      paused: opts.paused ?? false,
      deletedAt: null,
      lastDeliveryAt: null,
      lastDeliveryStatus: null,
      failureCount: 0,
    });
}

async function clearWebhooks(): Promise<void> {
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
  await seedWebhook(SITE_ID, WEBHOOK_ID);
});

test.afterEach(async () => {
  await clearWebhooks();
});

test('pause -> resume -> rotate-secret -> delete round-trip', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  await page.goto('/settings/webhooks');
  await expect(page.getByRole('heading', { name: 'webhooks', exact: true })).toBeVisible();

  const card = page.locator(`code:has-text("${WEBHOOK_URL}")`).locator('xpath=ancestor::*[@data-slot="card"][1]');
  await expect(card).toBeVisible();
  await expect(card.getByText('active', { exact: true })).toBeVisible();

  // 1) pause — PATCH { paused: true }
  const pauseResponsePromise = page.waitForResponse(
    (res) =>
      res.url().includes(`/api/webhooks/${WEBHOOK_ID}`) &&
      res.request().method() === 'PATCH',
    { timeout: 10_000 },
  );
  await card.locator('button:has(svg.lucide-pause)').click();
  const pauseResponse = await pauseResponsePromise;
  expect(pauseResponse.status()).toBe(200);
  expect(pauseResponse.request().postDataJSON()).toEqual({ paused: true });

  await expect(page.getByText('webhook paused')).toBeVisible();
  await expect(card.getByText('paused', { exact: true })).toBeVisible();
  await expect(card.getByText('active', { exact: true })).toBeHidden();

  await expect.poll(
    async () => {
      const snap = await getAdminDb()
        .collection('sites').doc(SITE_ID)
        .collection('webhooks').doc(WEBHOOK_ID).get();
      return snap.data()?.paused;
    },
    { timeout: 5_000, intervals: [100, 250, 500] },
  ).toBe(true);

  // 2) resume — PATCH { paused: false }
  const resumeResponsePromise = page.waitForResponse(
    (res) =>
      res.url().includes(`/api/webhooks/${WEBHOOK_ID}`) &&
      res.request().method() === 'PATCH',
    { timeout: 10_000 },
  );
  await card.locator('button:has(svg.lucide-play)').click();
  const resumeResponse = await resumeResponsePromise;
  expect(resumeResponse.status()).toBe(200);
  expect(resumeResponse.request().postDataJSON()).toEqual({ paused: false });

  await expect(page.getByText('webhook resumed')).toBeVisible();
  await expect(card.getByText('active', { exact: true })).toBeVisible();
  await expect(card.getByText('paused', { exact: true })).toBeHidden();

  await expect.poll(
    async () => {
      const snap = await getAdminDb()
        .collection('sites').doc(SITE_ID)
        .collection('webhooks').doc(WEBHOOK_ID).get();
      return snap.data()?.paused;
    },
    { timeout: 5_000, intervals: [100, 250, 500] },
  ).toBe(false);

  // 3) rotate-secret — confirm() -> POST -> new whsec_* in reveal banner
  page.once('dialog', (d) => {
    expect(d.message()).toMatch(/rotate signing secret/i);
    void d.accept();
  });
  const rotateResponsePromise = page.waitForResponse(
    (res) =>
      res.url().includes(`/api/webhooks/${WEBHOOK_ID}/rotate-secret`) &&
      res.request().method() === 'POST',
    { timeout: 10_000 },
  );
  await card.locator('button:has(svg.lucide-refresh-cw)').click();
  const rotateResponse = await rotateResponsePromise;
  expect(rotateResponse.status()).toBe(200);
  const rotateBody = (await rotateResponse.json()) as {
    signingSecret: string;
    previousSecretValidUntil: string;
  };
  expect(rotateBody.signingSecret).toMatch(/^whsec_[0-9a-f]{64}$/);
  expect(rotateBody.signingSecret).not.toBe(SEEDED_SECRET);

  const revealBanner = page.locator('text=signing secret issued')
    .locator('xpath=ancestor::*[@data-slot="card"][1]');
  await expect(revealBanner).toBeVisible();
  const revealedCode = revealBanner.locator('code');
  await expect(revealedCode).toHaveText(rotateBody.signingSecret);

  await revealBanner.locator('button:has(svg.lucide-copy)').click();
  await expect(page.getByText('copied to clipboard')).toBeVisible();
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toBe(rotateBody.signingSecret);

  await expect.poll(
    async () => {
      const snap = await getAdminDb()
        .collection('sites').doc(SITE_ID)
        .collection('webhooks').doc(WEBHOOK_ID).get();
      return snap.data()?.signingSecret;
    },
    { timeout: 5_000, intervals: [100, 250, 500] },
  ).toBe(rotateBody.signingSecret);

  const rotatedDoc = await getAdminDb()
    .collection('sites').doc(SITE_ID)
    .collection('webhooks').doc(WEBHOOK_ID).get();
  expect(rotatedDoc.data()?.previousSigningSecret).toBe(SEEDED_SECRET);

  // 4) delete — confirm() -> DELETE -> row disappears (soft-deleted, list filters)
  page.once('dialog', (d) => {
    expect(d.message()).toMatch(/delete this webhook/i);
    void d.accept();
  });
  const deleteResponsePromise = page.waitForResponse(
    (res) =>
      res.url().includes(`/api/webhooks/${WEBHOOK_ID}`) &&
      res.request().method() === 'DELETE',
    { timeout: 10_000 },
  );
  await card.locator('button:has(svg.lucide-trash-2)').click();
  const deleteResponse = await deleteResponsePromise;
  expect(deleteResponse.status()).toBe(200);
  const deleteBody = (await deleteResponse.json()) as {
    softDeleted: boolean;
    tombstoneExpiresAt: string;
  };
  expect(deleteBody.softDeleted).toBe(true);
  expect(deleteBody.tombstoneExpiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

  await expect(page.getByText('webhook deleted')).toBeVisible();
  await expect(page.locator(`code:has-text("${WEBHOOK_URL}")`)).toHaveCount(0);
  await expect(page.getByText('no webhooks yet')).toBeVisible();

  await expect.poll(
    async () => {
      const snap = await getAdminDb()
        .collection('sites').doc(SITE_ID)
        .collection('webhooks').doc(WEBHOOK_ID).get();
      const data = snap.data();
      return Boolean(data?.deletedAt) && data?.paused === true;
    },
    { timeout: 5_000, intervals: [100, 250, 500] },
  ).toBe(true);
});
