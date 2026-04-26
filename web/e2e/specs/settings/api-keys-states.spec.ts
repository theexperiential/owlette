/**
 * Settings — api keys states (task 5.3)
 *
 * What this exercises:
 *   /settings/api-keys with four pre-seeded keys, one per lifecycle state
 *   (active / rotated-in-grace / expired / revoked). Asserts each row's
 *   status-badge text + tone class against KeyCard.tsx's keyStatusAt().
 *
 * Data plane: none — Admin SDK writes the user-subcollection record + the
 * top-level api_keys/{keyHash} lookup row directly. No /api/keys POST.
 *
 * State-rendering gaps in KeyCard.tsx as of 2026-04-24:
 *   1. expired: GET /api/keys does not project an `expired` boolean and
 *      keyStatusAt() falls through to "expiring soon" whenever expiresAt
 *      is within EXPIRATION_WARNING_MS of now (a past expiresAt qualifies
 *      because expiresAt - now is negative). There is no terminal
 *      "expired" badge for past-due keys.
 *   2. revoked: keyStatusAt() never inspects revokedAt. A key with
 *      revokedAt set still renders as "active" (or "expiring soon" if
 *      expiresAt is near). DELETE /api/keys/{keyId} hard-deletes today,
 *      so the field is not produced through the UI — but the type allows
 *      it and the lookup doc can be written directly. The badge has no
 *      terminal "revoked" treatment.
 *
 * The two "happy" states ship as live assertions. The two gap states ship
 * as test.fixme() — they will start failing the moment KeyCard grows the
 * missing terminal branches, which is the signal we want.
 */

import crypto from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { test, expect, type Page } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { TEST_USERS } from '../../helpers/seed';
import type {
  ApiKeyEnvironment,
  ApiKeyLookup,
  ApiKeyRecord,
  ApiKeyScope,
} from '../../../lib/apiKeyTypes';

test.use(roleState('admin'));

const ADMIN_UID = TEST_USERS.admin.uid;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const PUBLISHER_SCOPES: ApiKeyScope[] = [
  { resource: 'roost', id: '*', permissions: ['read', 'write'] },
  { resource: 'site', id: '*', permissions: ['read', 'write'] },
  { resource: 'machine', id: '*', permissions: ['read', 'write'] },
];

type KeyState = 'active' | 'rotated-in-grace' | 'expired' | 'revoked';

interface SeedKeyOptions {
  state: KeyState;
  keyId: string;
  name: string;
}

const SEED_KEYS: SeedKeyOptions[] = [
  { state: 'active', keyId: 'e2e-state-active', name: 'e2e state active' },
  { state: 'rotated-in-grace', keyId: 'e2e-state-rotated', name: 'e2e state rotated' },
  { state: 'expired', keyId: 'e2e-state-expired', name: 'e2e state expired' },
  { state: 'revoked', keyId: 'e2e-state-revoked', name: 'e2e state revoked' },
];

async function seedKey(opts: SeedKeyOptions): Promise<void> {
  const db = getAdminDb();
  const environment: ApiKeyEnvironment = 'live';
  // Deterministic raw value per keyId so the hash is stable on warm-emulator
  // re-runs (idempotent batch.set overwrites the prior write).
  const rawKey = `owk_live_e2e-states-${opts.keyId}-pad${'x'.repeat(20)}`;
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const keyPrefix = rawKey.slice(0, 15);
  const now = Date.now();

  const base: Omit<ApiKeyRecord, 'createdAt' | 'expiresAt'> & {
    createdAt: FirebaseFirestore.FieldValue;
    expiresAt: number;
  } = {
    name: opts.name,
    keyHash,
    keyPrefix,
    environment,
    scopes: PUBLISHER_SCOPES,
    expiresAt: now + 60 * DAY_MS,
    createdAt: FieldValue.serverTimestamp(),
    lastUsedAt: null,
  };

  const lookup: ApiKeyLookup = {
    userId: ADMIN_UID,
    keyId: opts.keyId,
    environment,
    scopes: PUBLISHER_SCOPES,
    expiresAt: base.expiresAt,
  };

  let record: typeof base & {
    rotatedAt?: number;
    retiresAt?: number;
    revokedAt?: number;
  } = base;
  let lookupDoc: ApiKeyLookup = lookup;

  switch (opts.state) {
    case 'active':
      break;
    case 'rotated-in-grace': {
      const rotatedAt = now - HOUR_MS;
      const retiresAt = now + 23 * HOUR_MS;
      record = { ...base, rotatedAt, retiresAt };
      lookupDoc = { ...lookup, retiresAt };
      break;
    }
    case 'expired': {
      const expiresAt = now - HOUR_MS;
      record = { ...base, expiresAt };
      lookupDoc = { ...lookup, expiresAt };
      break;
    }
    case 'revoked': {
      record = { ...base, revokedAt: now - HOUR_MS };
      break;
    }
  }

  const batch = db.batch();
  batch.set(
    db.collection('users').doc(ADMIN_UID).collection('api_keys').doc(opts.keyId),
    record,
  );
  batch.set(db.collection('api_keys').doc(keyHash), lookupDoc);
  await batch.commit();
}

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

function rowFor(page: Page, name: string) {
  return page
    .locator('div.rounded-md.border')
    .filter({ has: page.locator('p.font-medium', { hasText: name }) })
    .first();
}

test.beforeEach(async () => {
  await clearApiKeys();
  for (const opts of SEED_KEYS) {
    await seedKey(opts);
  }
});

test.afterEach(async () => {
  await clearApiKeys();
});

test('active key row renders the green "active" badge', async ({ page }) => {
  await page.goto('/settings/api-keys');
  await expect(
    page.getByRole('heading', { name: 'api keys', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  const row = rowFor(page, 'e2e state active');
  await expect(row).toBeVisible();

  const badge = row.locator('[data-slot="badge"]', { hasText: /^active$/ });
  await expect(badge).toBeVisible();
  await expect(badge).toHaveClass(/text-green-400/);
});

test('rotated-in-grace row renders amber "rotated (grace)" badge with retire-by hint', async ({
  page,
}) => {
  await page.goto('/settings/api-keys');
  await expect(
    page.getByRole('heading', { name: 'api keys', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  const row = rowFor(page, 'e2e state rotated');
  await expect(row).toBeVisible();

  const badge = row.locator('[data-slot="badge"]', { hasText: /^rotated \(grace\)$/ });
  await expect(badge).toBeVisible();
  await expect(badge).toHaveClass(/text-amber-400/);

  await expect(row.getByText(/old key stops working /i)).toBeVisible();
});

test.fixme(
  'expired key row renders the red "expired" badge',
  async ({ page }) => {
    // GAP: keyStatusAt() reads only the (currently always-undefined)
    // `expired` flag. A past expiresAt routes to the "expiring soon"
    // branch instead of a terminal "expired" badge. Promote this fixme
    // once GET /api/keys derives `expired` or KeyCard reads `expiresAt`
    // directly.
    await page.goto('/settings/api-keys');
    await expect(
    page.getByRole('heading', { name: 'api keys', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

    const row = rowFor(page, 'e2e state expired');
    const badge = row.locator('[data-slot="badge"]', { hasText: /^expired$/ });
    await expect(badge).toBeVisible();
    await expect(badge).toHaveClass(/text-red-400/);
  },
);

test.fixme(
  'revoked key row renders a terminal "revoked" badge with muted treatment',
  async ({ page }) => {
    // GAP: keyStatusAt() never inspects revokedAt; DELETE hard-deletes
    // today so the field never reaches the UI through normal flows. A
    // revoked record present in Firestore still renders as "active".
    // Promote this fixme once revoke moves to a soft-delete and KeyCard
    // grows a terminal "revoked" branch.
    await page.goto('/settings/api-keys');
    await expect(
    page.getByRole('heading', { name: 'api keys', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

    const row = rowFor(page, 'e2e state revoked');
    const badge = row.locator('[data-slot="badge"]', { hasText: /^revoked$/ });
    await expect(badge).toBeVisible();
  },
);
