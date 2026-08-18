/**
 * Settings — api keys rotate + revoke (task 5.2)
 *
 * Two existing keys are seeded directly via the Admin SDK (both halves of
 * the storage contract: users/{userId}/api_keys/{keyId} + the lookup-table
 * doc at api_keys/{keyHash}). The spec then drives the /settings/api-keys
 * UI:
 *
 *   key #1 — rotate: clicks the rotate icon, asserts the new owk_* raw
 *     key is revealed once in the dismissible card at the top of the
 *     page, and the original row's status badge flips to "rotated
 *     (grace)" once the GET refresh returns the rotatedAt + retiresAt
 *     timestamps.
 *
 *   key #2 — revoke: clicks the trash icon, confirms via the inline
 *     "revoke?" yes/no, and asserts the row disappears (the route
 *     deletes both the user subdoc and the lookup table entry; there
 *     is no audit-preserved muted state today — see report).
 *
 * data plane: none — the rotation + revocation flows are pure firestore
 * round-trips through the next.js routes; no r2, no chunks, no agents.
 */

import { test, expect } from '@playwright/test';
import crypto from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { TEST_USERS } from '../../helpers/seed';
import type {
  ApiKeyEnvironment,
  ApiKeyLookup,
  ApiKeyRecord,
  ApiKeyScope,
} from '@/lib/apiKeyTypes';

test.use(roleState('admin'));

const ADMIN_UID = TEST_USERS.admin.uid;
const KEY_ONE_ID = 'e2e-key-one';
const KEY_TWO_ID = 'e2e-key-two';
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

const OPERATOR_SCOPES: ApiKeyScope[] = [
  { resource: 'roost', id: '*', permissions: ['read', 'write', 'deploy', 'rollback'] },
  { resource: 'site', id: '*', permissions: ['read', 'write', 'deploy', 'rollback'] },
  { resource: 'machine', id: '*', permissions: ['read', 'write', 'deploy', 'rollback'] },
];

interface SeededKey {
  keyId: string;
  rawKey: string;
  keyHash: string;
  keyPrefix: string;
}

async function seedApiKey(
  userId: string,
  keyId: string,
  name: string,
  environment: ApiKeyEnvironment = 'live',
): Promise<SeededKey> {
  const db = getAdminDb();
  const rawKey = `owk_${environment}_${crypto.randomBytes(32).toString('base64url')}`;
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const keyPrefix = rawKey.slice(0, 15);
  const expiresAt = Date.now() + NINETY_DAYS_MS;

  const record: Omit<ApiKeyRecord, 'createdAt'> & {
    createdAt: FirebaseFirestore.FieldValue;
  } = {
    name,
    keyHash,
    keyPrefix,
    environment,
    scopes: OPERATOR_SCOPES,
    expiresAt,
    createdAt: FieldValue.serverTimestamp(),
    lastUsedAt: null,
  };

  const lookup: ApiKeyLookup = {
    userId,
    keyId,
    environment,
    scopes: OPERATOR_SCOPES,
    expiresAt,
  };

  const batch = db.batch();
  batch.set(db.collection('users').doc(userId).collection('api_keys').doc(keyId), record);
  batch.set(db.collection('api_keys').doc(keyHash), lookup);
  await batch.commit();

  return { keyId, rawKey, keyHash, keyPrefix };
}

async function cleanupApiKeys(userId: string): Promise<void> {
  const db = getAdminDb();
  const userKeys = await db.collection('users').doc(userId).collection('api_keys').get();
  const hashes = userKeys.docs
    .map((d) => (d.data() as Partial<ApiKeyRecord>).keyHash)
    .filter((h): h is string => typeof h === 'string' && h.length > 0);

  const batch = db.batch();
  for (const doc of userKeys.docs) batch.delete(doc.ref);
  for (const hash of hashes) batch.delete(db.collection('api_keys').doc(hash));
  await batch.commit();
}

let keyOne: SeededKey;
let keyTwo: SeededKey;

test.beforeEach(async () => {
  await cleanupApiKeys(ADMIN_UID);
  keyOne = await seedApiKey(ADMIN_UID, KEY_ONE_ID, 'rotate target');
  keyTwo = await seedApiKey(ADMIN_UID, KEY_TWO_ID, 'revoke target');
});

test.afterEach(async () => {
  await cleanupApiKeys(ADMIN_UID);
});

function rowByName(page: import('@playwright/test').Page, name: string) {
  return page
    .locator('div.rounded-md.border')
    .filter({ has: page.locator('p.font-medium', { hasText: name }) })
    .first();
}

/**
 * Expand a row and read the key prefix it reveals.
 *
 * KeyCard collapses the prefix and the scope summary behind a per-row toggle —
 * the row itself carries only name, status and the three dates, which is what
 * gives the name a readable column inside the account-settings dialog.
 */
async function revealedPrefix(row: ReturnType<typeof rowByName>): Promise<string> {
  await row.getByRole('button', { name: /^show details for / }).click();
  return (await row.locator('code').innerText()).trim();
}

/**
 * Pick an item out of a row's overflow menu.
 *
 * The three per-row actions live in one dropdown now; three buttons on an
 * active row versus one on an expired row was an 80px swing that came out of
 * the only flexible column, so no two rows agreed on where their columns
 * started. Radix renders the menu in a portal, so the item is located on
 * `page`, never inside the row.
 */
async function chooseRowAction(
  page: import('@playwright/test').Page,
  row: ReturnType<typeof rowByName>,
  item: RegExp,
) {
  await row.getByRole('button', { name: /^actions for / }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

test('rotate issues a new key, reveals it once, and stamps the original as rotated (grace)', async ({
  page,
}) => {
  await page.goto('/settings/api-keys');
  // Heading visibility doubles as the "AuthContext finished hydrating" wait —
  // KeyCard rows only render after `loading` flips false, so there's no need
  // for a separate spinner-gone guard. Bumped to 10s to cover cold-start
  // hydration when this spec runs late in a long suite.
  await expect(
    page.getByRole('heading', { name: 'api keys', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  const oldRow = rowByName(page, 'rotate target');
  await expect(oldRow).toBeVisible();
  await expect(oldRow.getByText('active', { exact: true })).toBeVisible();
  // The prefix is still shown — one toggle away rather than in the row.
  expect(await revealedPrefix(oldRow)).toBe(`${keyOne.keyPrefix}•••`);

  const rotateResponsePromise = page.waitForResponse(
    (res) =>
      res.url().includes(`/api/keys/${keyOne.keyId}/rotate`) &&
      res.request().method() === 'POST',
    { timeout: 10_000 },
  );

  await chooseRowAction(page, oldRow, /^rotate$/);

  const rotateResponse = await rotateResponsePromise;
  expect(rotateResponse.status()).toBe(200);
  const rotatePayload = (await rotateResponse.json()) as {
    success: boolean;
    key: string;
    keyId: string;
    keyPrefix: string;
    rotatedFromKeyId: string;
  };
  expect(rotatePayload.success).toBe(true);
  expect(rotatePayload.key).toMatch(/^owk_live_/);
  expect(rotatePayload.rotatedFromKeyId).toBe(keyOne.keyId);

  await expect(
    page.getByText('key issued — copy it now. it will not be shown again.'),
  ).toBeVisible();
  await expect(page.locator('code', { hasText: rotatePayload.key })).toBeVisible();

  await expect(oldRow.getByText('rotated (grace)', { exact: true })).toBeVisible();
  await expect(oldRow.getByText(/old key stops working/)).toBeVisible();

  // Rotation carries the name across, so both rows are called "rotate target";
  // the badge is what separates the successor from its predecessor.
  const newRow = page
    .locator('div.rounded-md.border')
    .filter({ has: page.locator('p.font-medium', { hasText: 'rotate target' }) })
    .filter({ hasText: 'active' })
    .first();
  await expect(newRow.getByText('active', { exact: true })).toBeVisible();
  // ...and expanding it proves the successor really carries the new prefix.
  expect(await revealedPrefix(newRow)).toBe(`${rotatePayload.keyPrefix}•••`);

  const oldRecord = await getAdminDb()
    .collection('users')
    .doc(ADMIN_UID)
    .collection('api_keys')
    .doc(keyOne.keyId)
    .get();
  const oldData = oldRecord.data() as Partial<ApiKeyRecord> | undefined;
  expect(typeof oldData?.rotatedAt).toBe('number');
  expect(typeof oldData?.retiresAt).toBe('number');

  const newRecord = await getAdminDb()
    .collection('users')
    .doc(ADMIN_UID)
    .collection('api_keys')
    .doc(rotatePayload.keyId)
    .get();
  expect(newRecord.exists).toBe(true);
  expect((newRecord.data() as Partial<ApiKeyRecord>).rotatedFromKeyId).toBe(keyOne.keyId);
});

test('revoke removes the targeted key from the list and deletes both firestore docs', async ({
  page,
}) => {
  await page.goto('/settings/api-keys');
  await expect(
    page.getByRole('heading', { name: 'api keys', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  const revokeRow = rowByName(page, 'revoke target');
  await expect(revokeRow).toBeVisible();

  // An active key revokes from the overflow menu; a terminal one keeps a bare
  // trash button, since a menu holding a single item is ceremony.
  await chooseRowAction(page, revokeRow, /^revoke$/);
  await expect(revokeRow.getByText('revoke?', { exact: true })).toBeVisible();

  const revokeResponsePromise = page.waitForResponse(
    (res) =>
      res.url().includes(`/api/keys/${keyTwo.keyId}`) &&
      res.request().method() === 'DELETE',
    { timeout: 10_000 },
  );

  await revokeRow.getByRole('button', { name: /^yes$/i }).click();

  const revokeResponse = await revokeResponsePromise;
  expect(revokeResponse.status()).toBe(200);

  await expect(rowByName(page, 'revoke target')).toHaveCount(0);
  await expect(rowByName(page, 'rotate target')).toBeVisible();

  const recordSnap = await getAdminDb()
    .collection('users')
    .doc(ADMIN_UID)
    .collection('api_keys')
    .doc(keyTwo.keyId)
    .get();
  expect(recordSnap.exists).toBe(false);

  const lookupSnap = await getAdminDb().collection('api_keys').doc(keyTwo.keyHash).get();
  expect(lookupSnap.exists).toBe(false);
});
