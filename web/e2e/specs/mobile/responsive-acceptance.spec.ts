/**
 * Mobile — responsive acceptance gate (task 1.3)
 *
 * One test per route: navigate at 390x844 (viewport/isMobile/hasTouch come from
 * the `mobile-chromium` project in playwright.config.ts, which owns every spec
 * under specs/mobile/**), wait for a real content anchor, then assert the
 * document does not scroll horizontally.
 *
 * `assertNoHorizontalOverflow` calls `stabilize` internally — animations off,
 * webfonts settled — so callers must NOT also call `stabilize`.
 *
 * Empty views cannot overflow, so every content-driven route is seeded with
 * real rows first (machines, log events, cortex chats, roosts, an api key, a
 * webhook) via the existing helpers. A route asserted against a bare empty
 * state would be a green test that proves nothing.
 *
 * Routes that overflow TODAY are declared with `test.fixme(...)` and each names
 * the task that owns the fix. Removing a fixme before that task lands must turn
 * the suite red — that is the entire point of this gate. When a fix lands,
 * delete the fixme marker; never soften the assertion to make a route pass.
 *
 * Every fixme here was verified to fail on the current tree before it was
 * marked — a fixme on a route that already passes is a silent lie (unlike
 * `test.fail()`, Playwright does not flag a fixme that would have passed).
 */

import { test, expect, type Page } from '@playwright/test';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '../../helpers/emulator';
import { assertNoHorizontalOverflow } from '../../helpers/mobile';
import { roleState } from '../../helpers/roles';
import {
  TEST_SITES,
  TEST_USERS,
  seedMachine,
  seedRoostWithVersionHistory,
} from '../../helpers/seed';
import {
  dedicatedUser,
  seedCortexFixture,
  seedDedicatedUser,
  seedLogEvents,
} from '../../helpers/coverageSeed';
import { mintApiKey, revokeApiKey, type MintedApiKey } from '../../helpers/apiKey';

const SITE_ID = TEST_SITES[0].id;
const MACHINE_ID = 'e2e-mobile-overflow-machine';
const ROOST_ID = 'rst_mobile_overflow_001';
const ROOST_NAME = 'mobile-overflow-roost';
const WEBHOOK_ID = 'e2e-mobile-overflow-webhook';
const WEBHOOK_URL = 'https://example.com/mobile-overflow/hook';
const API_KEY_NAME = 'e2e-mobile-overflow-key';

/**
 * Write a webhook subscription in the exact shape `POST /api/webhooks` stores
 * (app/api/webhooks/route.ts) so the settings page renders a real card — long
 * url in a <code>, per-event badges — rather than its empty state.
 */
async function seedWebhook(): Promise<void> {
  await getAdminDb()
    .collection('sites')
    .doc(SITE_ID)
    .collection('webhooks')
    .doc(WEBHOOK_ID)
    .set({
      schemaVersion: 1,
      url: WEBHOOK_URL,
      hostname: 'example.com',
      events: ['version.published', 'deployment.completed', 'machine.offline'],
      description: 'seeded by responsive-acceptance.spec.ts',
      signingSecret: `whsec_${'0'.repeat(64)}`,
      secretRotatedAt: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      createdBy: TEST_USERS.admin.uid,
      paused: false,
      deletedAt: null,
      lastDeliveryAt: null,
      lastDeliveryStatus: null,
      failureCount: 0,
    });
}

/**
 * Dashboard fleet with enough state to render the surfaces that actually stress
 * 390px: an online machine carrying a two-monitor display profile plus a
 * reboot-pending banner (approve/dismiss buttons, card view only), and a second
 * machine whose heartbeat is stale enough to render offline. Both shapes come
 * from seedMachine's existing options — no bespoke fixture.
 */
async function seedDashboardMachines(): Promise<void> {
  await seedMachine(SITE_ID, MACHINE_ID, { rebootPending: true });
  await seedMachine(SITE_ID, `${MACHINE_ID}-offline`, { heartbeatOffsetSec: 600 });
}

test.describe('mobile responsive acceptance — public routes', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('/login does not scroll horizontally', async ({ page }) => {
    await page.goto('/login');
    // Progressive form — the password field and submit button only mount once
    // email receives focus, so a bare `goto` measures a two-button shell.
    await page.getByLabel(/^email$/i).fill('mobile-overflow@e2e.test');
    await expect(page.getByRole('button', { name: /sign in with email/i })).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  // Task 4.4 lists /register as broken, but the expanded form fits at 390px on
  // the current tree — so this asserts live rather than carrying a fixme that
  // would pass. If 4.4 has a concrete /register defect, it is not document-level
  // horizontal overflow.
  test('/register does not scroll horizontally', async ({ page }) => {
    await page.goto('/register');
    // The form is progressive — name/password fields only expand once email
    // receives focus (see auth/signup.spec.ts). Measure the full form, not the
    // collapsed one-field state.
    await page.getByLabel(/^email$/i).fill('mobile-overflow@e2e.test');
    await expect(page.getByLabel(/first name/i)).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  test('/demo does not scroll horizontally', async ({ page }) => {
    await page.goto('/demo');
    await expect(page.getByRole('heading', { name: /welcome to owlette!/i })).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });
});

test.describe('mobile responsive acceptance — fresh-user routes', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  /**
   * /setup-2fa is only reachable as a signed-in user who has not yet enrolled.
   * Mirrors mfa/setup-verify.spec.ts: seed a dedicated member, sign in through
   * the real login form, then navigate to the setup page.
   */
  async function signInFreshUser(page: Page): Promise<void> {
    const user = await seedDedicatedUser(
      dedicatedUser('member', `mobile-2fa-${Date.now()}`),
    );
    await page.goto('/login');
    await page.getByLabel(/email/i).fill(user.email);
    await page.getByLabel(/password/i).first().fill(user.password);
    await page.getByRole('button', { name: /sign in with email/i }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
  }

  // Task 4.4 lists /setup-2fa as broken, but the qr + secret card fits at 390px
  // on the current tree — asserted live rather than fixme'd for the same reason
  // as /register above.
  test('/setup-2fa does not scroll horizontally', async ({ page }) => {
    await signInFreshUser(page);
    await page.goto('/setup-2fa');
    await expect(page.getByText(/set up two-factor authentication/i).first()).toBeVisible();
    await expect(page.getByAltText(/2FA QR Code/i)).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });
});

test.describe('mobile responsive acceptance — authenticated routes', () => {
  test.use(roleState('admin'));

  let mintedKey: MintedApiKey | null = null;

  test.afterAll(async () => {
    if (mintedKey) {
      await revokeApiKey(mintedKey);
      mintedKey = null;
    }
    await getAdminDb()
      .collection('sites')
      .doc(SITE_ID)
      .collection('webhooks')
      .doc(WEBHOOK_ID)
      .delete();
  });

  test('/dashboard (card view) does not scroll horizontally', async ({ page }) => {
    await seedDashboardMachines();
    await page.goto('/dashboard');
    // Card is the default view (dashboard/page.tsx seeds viewType='card' and
    // only overrides it from localStorage, which the role fixture never sets).
    await expect(page.getByTestId('machine-card').first()).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  // Task 3.4 owns the dashboard, but only the CARD view overflows the document
  // today — the list table is `table-layout: fixed` + `contain: layout`, so it
  // clips rather than widening the page. Asserted live so 3.4 can't regress it.
  test('/dashboard (list view) does not scroll horizontally', async ({ page }) => {
    await seedDashboardMachines();
    await page.goto('/dashboard');
    await expect(page.getByTestId('machine-card').first()).toBeVisible();

    await page.getByTestId('view-toggle-list').click();
    // Park the pointer away from the toggle so its Radix tooltip isn't part of
    // the measured layout.
    await page.mouse.move(0, 0);
    await expect(page.getByTestId('machine-row').first()).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  test('/logs does not scroll horizontally', async ({ page }) => {
    await seedLogEvents(SITE_ID);
    await page.goto('/logs');
    await expect(page.getByRole('heading', { name: /^logs$/i })).toBeVisible();
    await expect(page.getByText('TouchDesigner', { exact: true }).first()).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  // Task 3.3 owns /cortex, but the route does not overflow the DOCUMENT at 390px
  // today (this gate's measurement — see helpers/mobile.ts). If 3.3 is chasing an
  // inner-pane scroller, that needs its own assertion; this one asserts live so
  // 3.3 can't regress the document width.
  test('/cortex does not scroll horizontally', async ({ page }) => {
    await seedCortexFixture({ userId: TEST_USERS.admin.uid });
    await page.goto('/cortex');
    // The seeded conversations live behind a collapsed sidebar at this width,
    // so anchor on the always-mounted composer + target selector instead.
    await expect(page.getByLabel(/cortex target/i)).toBeVisible();
    await expect(page.getByPlaceholder(/ask about this machine/i)).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  // FIXME(task 4.4): the `deployments` heading + inline stats cluster is a
  // non-wrapping flex row that pushes the document to ~512px at a 390px
  // viewport. Delete this marker when 4.4 lands.
  test.fixme('/deployments does not scroll horizontally', async ({ page }) => {
    await seedMachine(SITE_ID, MACHINE_ID);
    await page.goto('/deployments');
    await expect(
      page.getByRole('heading', { name: 'deployments', exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await assertNoHorizontalOverflow(page);
  });

  test('/roosts does not scroll horizontally', async ({ page }) => {
    await seedMachine(SITE_ID, MACHINE_ID);
    await seedRoostWithVersionHistory(SITE_ID, ROOST_ID, {
      name: ROOST_NAME,
      targets: [MACHINE_ID],
      versionCount: 2,
      descriptions: ['initial import', 'mobile responsive acceptance fixture'],
    });
    await page.goto('/roosts');
    await expect(
      page.getByRole('heading', { name: 'roosts', exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`[data-roost-row="${ROOST_ID}"]`)).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  test('/settings/api-keys does not scroll horizontally', async ({ page }) => {
    mintedKey = await mintApiKey({
      ownerUid: TEST_USERS.admin.uid,
      name: API_KEY_NAME,
      scopes: [{ resource: 'site', id: SITE_ID, permissions: ['read', 'write'] }],
    });
    await page.goto('/settings/api-keys');
    await expect(
      page.getByRole('heading', { name: 'api keys', exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(API_KEY_NAME)).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  test('/settings/webhooks does not scroll horizontally', async ({ page }) => {
    await seedWebhook();
    await page.goto('/settings/webhooks');
    await expect(
      page.getByRole('heading', { name: 'webhooks', exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('code', { hasText: WEBHOOK_URL })).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  test('/settings/alerts does not scroll horizontally', async ({ page }) => {
    await page.goto('/settings/alerts');
    await expect(
      page.getByRole('heading', { name: 'manage alerts', exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await assertNoHorizontalOverflow(page);
  });

  test('/add does not scroll horizontally', async ({ page }) => {
    await page.goto('/add?code=silver-compass-drift');
    await expect(page.getByText('add machine').first()).toBeVisible();
    await expect(page.getByLabel(/pairing phrase/i)).toHaveValue('silver-compass-drift');
    await assertNoHorizontalOverflow(page);
  });
});
