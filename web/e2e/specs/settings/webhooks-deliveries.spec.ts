/**
 * Settings — webhook deliveries panel + manual retry (task 5.6)
 *
 * Exercises:
 *   A. expanded webhook row renders the recent-deliveries list newest-first,
 *      with state icons (success/failure/pending), attempt number, http
 *      status code, and a relative timestamp.
 *   B. clicking the retry icon on a failed delivery fires
 *      POST /api/webhooks/{webhookId}/deliveries/{deliveryId}/retry and
 *      a new pending delivery row appears in firestore with `retryOf`
 *      pointing at the original.
 *
 * data plane: none — deliveries seeded directly via Admin SDK into the
 * top-level `webhook_deliveries` collection (the dispatcher's store, see
 * web/app/api/webhooks/[webhookId]/deliveries/route.ts).
 */

import { test, expect, type Page } from '@playwright/test';
import { FieldValue } from 'firebase-admin/firestore';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const WEBHOOK_ID = 'wh_e2edeliveries01';
const WEBHOOK_URL = 'https://example.com/e2e-deliveries-hook';
const SIGNING_SECRET = `whsec_${'a'.repeat(64)}`;
const CANONICAL_BODY = JSON.stringify({ event: 'roost.version.published', test: true });

const DELIVERY_SUCCEEDED_ID = 'dlv_e2e_succeeded_01';
const DELIVERY_FAILED_ID = 'dlv_e2e_failed_02';
const DELIVERY_PENDING_ID = 'dlv_e2e_pending_03';

interface SeedDeliveryOptions {
  id: string;
  state: 'pending' | 'succeeded' | 'failed';
  attempt: number;
  lastStatus: number | null;
  createdAtMs: number;
  completedAtMs?: number | null;
  event?: string;
}

async function seedWebhook(): Promise<void> {
  const db = getAdminDb();
  await db
    .collection('sites')
    .doc(SITE_ID)
    .collection('webhooks')
    .doc(WEBHOOK_ID)
    .set({
      schemaVersion: 1,
      url: WEBHOOK_URL,
      hostname: 'example.com',
      events: ['roost.version.published'],
      signingSecret: SIGNING_SECRET,
      secretRotatedAt: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      createdBy: 'admin-uid',
      paused: false,
      deletedAt: null,
      lastDeliveryAt: null,
      lastDeliveryStatus: null,
      failureCount: 0,
    });
}

async function seedDelivery(opts: SeedDeliveryOptions): Promise<void> {
  const db = getAdminDb();
  const event = opts.event ?? 'roost.version.published';
  await db
    .collection('webhook_deliveries')
    .doc(opts.id)
    .set({
      id: opts.id,
      subscriptionId: WEBHOOK_ID,
      siteId: SITE_ID,
      url: WEBHOOK_URL,
      canonicalBody: CANONICAL_BODY,
      headers: {
        'Content-Type': 'application/json',
        'Roost-Event': event,
        'Roost-Delivery': opts.id,
        'Roost-Signature': 't=0,v1=deadbeef',
      },
      event,
      attempt: opts.attempt,
      state: opts.state,
      lastStatus: opts.lastStatus,
      lastError: opts.state === 'failed' ? 'http 500 internal server error' : null,
      nextAttemptAt: opts.state === 'pending' ? opts.createdAtMs : null,
      createdAt: opts.createdAtMs,
      completedAt: opts.completedAtMs ?? null,
      secret: SIGNING_SECRET,
    });
}

async function cleanup(): Promise<void> {
  const db = getAdminDb();
  await db
    .collection('sites')
    .doc(SITE_ID)
    .collection('webhooks')
    .doc(WEBHOOK_ID)
    .delete()
    .catch(() => {});

  const deliveries = await db
    .collection('webhook_deliveries')
    .where('subscriptionId', '==', WEBHOOK_ID)
    .get();
  await Promise.all(deliveries.docs.map((d) => d.ref.delete()));
}

function deliveryRows(page: Page) {
  return page
    .locator('div.text-xs.py-1.px-2')
    .filter({ has: page.locator('span.font-mono', { hasText: 'roost.version.published' }) });
}

async function gotoExpandedWebhook(page: Page): Promise<void> {
  await page.goto('/settings/webhooks');
  await expect(
    page.getByRole('heading', { name: 'webhooks', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  const row = page.locator('div').filter({ hasText: WEBHOOK_URL }).first();
  await expect(row).toBeVisible();

  await page.waitForResponse(
    (res) =>
      res.url().includes(`/api/webhooks/${WEBHOOK_ID}/deliveries`) &&
      res.request().method() === 'GET',
    { timeout: 10_000 },
  ).catch(() => undefined);

  const expandButton = page.getByRole('button', { name: 'expand' }).first();
  await expandButton.click();

  await expect(
    page.getByRole('heading', { name: 'recent deliveries' }),
  ).toBeVisible();
}

test.beforeEach(async () => {
  await cleanup();
  await seedWebhook();

  const now = Date.now();
  await seedDelivery({
    id: DELIVERY_SUCCEEDED_ID,
    state: 'succeeded',
    attempt: 1,
    lastStatus: 200,
    createdAtMs: now - 30 * 60_000,
    completedAtMs: now - 30 * 60_000 + 200,
  });
  await seedDelivery({
    id: DELIVERY_FAILED_ID,
    state: 'failed',
    attempt: 3,
    lastStatus: 500,
    createdAtMs: now - 10 * 60_000,
    completedAtMs: now - 10 * 60_000 + 500,
  });
  await seedDelivery({
    id: DELIVERY_PENDING_ID,
    state: 'pending',
    attempt: 0,
    lastStatus: null,
    createdAtMs: now - 60_000,
  });
});

test.afterEach(async () => {
  await cleanup();
});

test('expanded row lists deliveries newest-first with state icons, attempts, and status codes', async ({
  page,
}) => {
  const deliveriesPromise = page.waitForResponse(
    (res) =>
      res.url().includes(`/api/webhooks/${WEBHOOK_ID}/deliveries`) &&
      res.request().method() === 'GET',
    { timeout: 10_000 },
  );

  await page.goto('/settings/webhooks');
  await expect(
    page.getByRole('heading', { name: 'webhooks', exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('div').filter({ hasText: WEBHOOK_URL }).first()).toBeVisible();

  await page.getByRole('button', { name: 'expand' }).first().click();
  const response = await deliveriesPromise;
  expect(response.status()).toBe(200);

  await expect(
    page.getByRole('heading', { name: 'recent deliveries' }),
  ).toBeVisible();

  const rows = deliveryRows(page);
  await expect(rows).toHaveCount(3);

  const pendingRow = rows.nth(0);
  await expect(pendingRow.locator('svg.lucide-clock')).toBeVisible();
  await expect(pendingRow.getByText('pending', { exact: true })).toBeVisible();
  await expect(pendingRow.getByText('att 0', { exact: true })).toBeVisible();

  const failedRow = rows.nth(1);
  await expect(failedRow.locator('svg.lucide-circle-x, svg.lucide-x-circle')).toHaveCount(1);
  await expect(failedRow.getByText('500', { exact: true })).toBeVisible();
  await expect(failedRow.getByText('att 3', { exact: true })).toBeVisible();

  const succeededRow = rows.nth(2);
  // CheckCircle2 in lucide-react v0.548 re-exports from circle-check, which
  // renders class "lucide-circle-check" (no "-big" suffix and not the legacy
  // "check-circle-2" alias). Accept either modern variant so this remains
  // robust across minor lucide bumps.
  await expect(
    succeededRow.locator('svg.lucide-circle-check, svg.lucide-circle-check-big'),
  ).toHaveCount(1);
  await expect(succeededRow.getByText('200', { exact: true })).toBeVisible();
  await expect(succeededRow.getByText('att 1', { exact: true })).toBeVisible();
});

test('retrying a failed delivery posts /retry and seeds a pending delivery with retryOf set', async ({
  page,
}) => {
  await gotoExpandedWebhook(page);

  const rows = deliveryRows(page);
  await expect(rows).toHaveCount(3);

  const failedRow = rows.nth(1);
  await expect(failedRow.getByText('500', { exact: true })).toBeVisible();

  const retryResponsePromise = page.waitForResponse(
    (res) =>
      res
        .url()
        .includes(
          `/api/webhooks/${WEBHOOK_ID}/deliveries/${DELIVERY_FAILED_ID}/retry`,
        ) && res.request().method() === 'POST',
    { timeout: 10_000 },
  );

  await failedRow.locator('button:has(svg.lucide-rotate-ccw)').click();

  const retryResponse = await retryResponsePromise;
  expect(retryResponse.status()).toBe(202);
  const retryBody = (await retryResponse.json()) as {
    id: string;
    webhookId: string;
    retryOf: string;
    state: string;
  };
  expect(retryBody.webhookId).toBe(WEBHOOK_ID);
  expect(retryBody.retryOf).toBe(DELIVERY_FAILED_ID);
  expect(retryBody.state).toBe('pending');
  expect(retryBody.id.startsWith(`${DELIVERY_FAILED_ID}__retry_`)).toBe(true);

  await expect(page.getByText('retry queued', { exact: true })).toBeVisible();

  const db = getAdminDb();
  await expect
    .poll(
      async () => {
        const snap = await db
          .collection('webhook_deliveries')
          .where('retryOf', '==', DELIVERY_FAILED_ID)
          .get();
        return snap.docs.length;
      },
      { timeout: 5_000, intervals: [100, 250, 500] },
    )
    .toBe(1);

  const retrySnap = await db.collection('webhook_deliveries').doc(retryBody.id).get();
  expect(retrySnap.exists).toBe(true);
  const retryData = retrySnap.data()!;
  expect(retryData.subscriptionId).toBe(WEBHOOK_ID);
  expect(retryData.siteId).toBe(SITE_ID);
  expect(retryData.state).toBe('pending');
  expect(retryData.attempt).toBe(0);
  expect(retryData.retryOf).toBe(DELIVERY_FAILED_ID);

  const originalSnap = await db
    .collection('webhook_deliveries')
    .doc(DELIVERY_FAILED_ID)
    .get();
  expect(originalSnap.data()!.state).toBe('failed');
  expect(originalSnap.data()!.lastStatus).toBe(500);

  await expect
    .poll(async () => deliveryRows(page).count(), { timeout: 5_000 })
    .toBe(4);
});
