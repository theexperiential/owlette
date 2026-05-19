/**
 * api-sprint W5.4 — site-members e2e (track 3B / site-admin half).
 *
 * Hits the per-site member-management endpoints with a `site=<id>:admin` api
 * key. The platform-scoped user endpoints (promote / demote / assign-sites /
 * etc.) live in `users.spec.ts`.
 *
 * Verbs covered (≥1 happy-path each):
 *   - GET    /api/sites/{siteId}/members
 *   - POST   /api/sites/{siteId}/members
 *   - DELETE /api/sites/{siteId}/members/{uid}
 *
 * Negative paths:
 *   - 403 when the api key holds only `site:read` (admin scope is required)
 *   - 409 cannot_remove_owner when DELETE-ing the site owner
 */
import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { mintApiKey, revokeApiKey, authHeaders, type MintedApiKey } from '../../helpers/apiKey';
import { getAdminDb } from '../../helpers/emulator';

const SUFFIX = crypto.randomBytes(4).toString('hex');
const SITE_ID = `e2e-members-${SUFFIX}`;
const OWNER_UID = `e2e-owner-${SUFFIX}`;
const MEMBER_UID = `e2e-member-${SUFFIX}`;

let adminKey: MintedApiKey;
let readOnlyKey: MintedApiKey;

async function seedUser(uid: string, role: string): Promise<void> {
  const db = getAdminDb();
  await db.collection('users').doc(uid).set({
    email: `${uid}@e2e.test`,
    role,
    sites: [],
    displayName: uid,
    createdAt: new Date(),
    mfaEnrolled: false,
    requiresMfaSetup: false,
    passkeyEnrolled: false,
  });
}

test.beforeAll(async () => {
  const db = getAdminDb();
  await Promise.all([seedUser(OWNER_UID, 'admin'), seedUser(MEMBER_UID, 'member')]);
  await db.collection('sites').doc(SITE_ID).set({
    name: SITE_ID,
    owner: OWNER_UID,
    timezone: 'UTC',
    createdAt: new Date(),
  });
  // The owner needs `sites: [SITE_ID]` for membership-based site access in
  // the route handler; the api-key path will then enforce the `admin` scope
  // on top.
  await db
    .collection('users')
    .doc('admin-uid')
    .update({ sites: [...new Set(['site-A', SITE_ID])] });

  adminKey = await mintApiKey({
    ownerUid: 'admin-uid',
    name: `e2e-members-admin-${SUFFIX}`,
    scopes: [{ resource: 'site', id: SITE_ID, permissions: ['read', 'write', 'admin'] }],
  });
  readOnlyKey = await mintApiKey({
    ownerUid: 'admin-uid',
    name: `e2e-members-read-${SUFFIX}`,
    scopes: [{ resource: 'site', id: SITE_ID, permissions: ['read'] }],
  });
});

test.afterAll(async () => {
  if (adminKey) await revokeApiKey(adminKey);
  if (readOnlyKey) await revokeApiKey(readOnlyKey);
  const db = getAdminDb();
  await Promise.all([
    db.collection('users').doc(OWNER_UID).delete().catch(() => undefined),
    db.collection('users').doc(MEMBER_UID).delete().catch(() => undefined),
    db.collection('sites').doc(SITE_ID).delete().catch(() => undefined),
  ]);
});

test('GET /api/sites/{siteId}/members — lists members + owner', async ({ request }) => {
  const res = await request.get(`/api/sites/${SITE_ID}/members`, {
    headers: authHeaders(adminKey, false),
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.members)).toBe(true);
  // The owner is always surfaced even if they're not in the array-contains query.
  const ownerEntry = body.members.find((m: { uid: string }) => m.uid === OWNER_UID);
  expect(ownerEntry).toBeDefined();
  expect(ownerEntry?.role).toBe('owner');
});

test('POST /api/sites/{siteId}/members — adds a member, mutates user.sites[]', async ({ request }) => {
  const res = await request.post(`/api/sites/${SITE_ID}/members`, {
    headers: authHeaders(adminKey),
    data: { uid: MEMBER_UID, role: 'member' },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.uid).toBe(MEMBER_UID);
  expect(body.siteId).toBe(SITE_ID);

  const db = getAdminDb();
  const userSnap = await db.collection('users').doc(MEMBER_UID).get();
  expect(userSnap.data()?.sites).toContain(SITE_ID);
});

test('GET /api/sites/{siteId}/members — read-only scope rejected (admin required)', async ({ request }) => {
  const res = await request.get(`/api/sites/${SITE_ID}/members`, {
    headers: authHeaders(readOnlyKey, false),
  });
  expect(res.status()).toBe(403);
  const body = await res.json();
  expect(body.code).toBe('scope_insufficient');
});

test('DELETE /api/sites/{siteId}/members/{uid} — removes non-owner member', async ({ request }) => {
  // Add the member first.
  await request.post(`/api/sites/${SITE_ID}/members`, {
    headers: authHeaders(adminKey),
    data: { uid: MEMBER_UID, role: 'member' },
  });

  const res = await request.delete(`/api/sites/${SITE_ID}/members/${MEMBER_UID}`, {
    headers: authHeaders(adminKey),
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.uid).toBe(MEMBER_UID);
  expect(body.siteId).toBe(SITE_ID);
  expect(body.wasMember).toBe(true);

  const db = getAdminDb();
  const userSnap = await db.collection('users').doc(MEMBER_UID).get();
  expect((userSnap.data()?.sites ?? []) as string[]).not.toContain(SITE_ID);
});

test('DELETE /api/sites/{siteId}/members/{uid} — 409 cannot_remove_owner', async ({ request }) => {
  const res = await request.delete(`/api/sites/${SITE_ID}/members/${OWNER_UID}`, {
    headers: authHeaders(adminKey),
  });
  expect(res.status()).toBe(409);
  const body = await res.json();
  expect(body.code).toBe('cannot_remove_owner');
});
