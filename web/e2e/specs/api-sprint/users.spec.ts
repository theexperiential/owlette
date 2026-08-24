/**
 * users-api e2e: every verb of the platform-scoped user-management endpoints
 * (list, get, promote, demote, assign-sites, remove-sites, delete) driven by a
 * `user=*:admin` + `user=*:write` superadmin key, plus the 409 last_superadmin
 * and 409 orphan_sites paths. Site membership lives in `site-members.spec.ts`.
 */
import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { mintApiKey, revokeApiKey, authHeaders, type MintedApiKey } from '../../helpers/apiKey';
import { getAdminDb } from '../../helpers/emulator';

const SUFFIX = crypto.randomBytes(4).toString('hex');
// Created fresh per spec so concurrent runs cannot collide.
const TARGET_UID = `e2e-target-${SUFFIX}`;
const SUCCESSOR_UID = `e2e-successor-${SUFFIX}`;
const ORPHAN_OWNER_UID = `e2e-orphan-${SUFFIX}`;
const ORPHAN_SITE_ID = `e2e-orphan-site-${SUFFIX}`;
const ASSIGN_SITE_ID = `e2e-assign-site-${SUFFIX}`;

let superKey: MintedApiKey;

async function seedUser(uid: string, role: string, sites: string[] = []): Promise<void> {
  const db = getAdminDb();
  await db.collection('users').doc(uid).set({
    email: `${uid}@e2e.test`,
    role,
    sites,
    displayName: uid,
    createdAt: new Date(),
    mfaEnrolled: false,
    requiresMfaSetup: false,
    mfaFactors: { totp: false, passkeys: 0 },
  });
}

async function seedSite(siteId: string, owner: string): Promise<void> {
  const db = getAdminDb();
  await db.collection('sites').doc(siteId).set({
    name: siteId,
    owner,
    timezone: 'UTC',
    createdAt: new Date(),
  });
}

async function deleteUser(uid: string): Promise<void> {
  const db = getAdminDb();
  await db.collection('users').doc(uid).delete().catch(() => undefined);
}

async function deleteSite(siteId: string): Promise<void> {
  const db = getAdminDb();
  await db.collection('sites').doc(siteId).delete().catch(() => undefined);
}

test.beforeAll(async () => {
  superKey = await mintApiKey({
    ownerUid: 'super-uid',
    name: `e2e-users-super-${SUFFIX}`,
    scopes: [{ resource: 'user', id: '*', permissions: ['read', 'write', 'admin'] }],
  });
});

test.afterAll(async () => {
  if (superKey) await revokeApiKey(superKey);
  await Promise.all([
    deleteUser(TARGET_UID),
    deleteUser(SUCCESSOR_UID),
    deleteUser(ORPHAN_OWNER_UID),
    deleteSite(ORPHAN_SITE_ID),
    deleteSite(ASSIGN_SITE_ID),
  ]);
});

test.beforeEach(async () => {
  // Fresh target per test so earlier mutations cannot bleed through.
  await Promise.all([
    seedUser(TARGET_UID, 'member'),
    seedUser(SUCCESSOR_UID, 'admin'),
    seedSite(ASSIGN_SITE_ID, 'super-uid'),
  ]);
});

test('GET /api/users — lists platform users', async ({ request }) => {
  const res = await request.get('/api/users?page_size=50', {
    headers: authHeaders(superKey, false),
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.users)).toBe(true);
  // At minimum the canonical seeded users.
  const uids = body.users.map((u: { uid: string }) => u.uid);
  expect(uids.length).toBeGreaterThanOrEqual(3);
});

test('GET /api/users/{uid} — returns single user detail', async ({ request }) => {
  const res = await request.get(`/api/users/${TARGET_UID}`, {
    headers: authHeaders(superKey, false),
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.uid).toBe(TARGET_UID);
  expect(body.role).toBe('member');
});

test('POST /api/users/{uid}/promote — flips role to admin', async ({ request }) => {
  const res = await request.post(`/api/users/${TARGET_UID}/promote`, {
    headers: authHeaders(superKey),
    data: { role: 'admin' },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.uid).toBe(TARGET_UID);
  expect(body.role).toBe('admin');
  expect(body.changed).toBe(true);

  const db = getAdminDb();
  const userSnap = await db.collection('users').doc(TARGET_UID).get();
  expect(userSnap.data()?.role).toBe('admin');
});

test('POST /api/users/{uid}/demote — flips superadmin → member', async ({ request }) => {
  // Second superadmin so demoting the target does not trip the floor.
  const extraSuper = `e2e-extra-super-${SUFFIX}`;
  await seedUser(extraSuper, 'superadmin');
  await seedUser(TARGET_UID, 'superadmin');

  try {
    const res = await request.post(`/api/users/${TARGET_UID}/demote`, {
      headers: authHeaders(superKey),
      data: {},
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.role).toBe('member');
  } finally {
    await deleteUser(extraSuper);
  }
});

test('POST /api/users/{uid}/demote — 409 last_superadmin when demoting the only superadmin', async ({ request }) => {
  // Target becomes the ONLY active superadmin (canonical super-uid soft-deleted)
  // so it can trip the last-superadmin guard with live credentials.
  await seedUser(TARGET_UID, 'superadmin');
  const targetSuperKey = await mintApiKey({
    ownerUid: TARGET_UID,
    name: `e2e-users-target-super-${SUFFIX}`,
    scopes: [{ resource: 'user', id: '*', permissions: ['read', 'write', 'admin'] }],
  });
  const db = getAdminDb();
  const superSnap = await db.collection('users').doc('super-uid').get();
  const previousRole = superSnap.data()?.role;

  try {
    await db.collection('users').doc('super-uid').update({ deletedAt: Date.now() });
    const res = await request.post(`/api/users/${TARGET_UID}/demote`, {
      headers: authHeaders(targetSuperKey),
      data: {},
    });
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('last_superadmin');
  } finally {
    await revokeApiKey(targetSuperKey);
    // Restore the canonical superadmin for the rest of the suite.
    await db
      .collection('users')
      .doc('super-uid')
      .update({ deletedAt: null, role: previousRole ?? 'superadmin' });
  }
});

test('POST /api/users/{uid}/assign-sites — adds siteIds via arrayUnion', async ({ request }) => {
  const res = await request.post(`/api/users/${TARGET_UID}/assign-sites`, {
    headers: authHeaders(superKey),
    data: { siteIds: [ASSIGN_SITE_ID] },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.assignedSiteIds).toEqual([ASSIGN_SITE_ID]);

  const db = getAdminDb();
  const userSnap = await db.collection('users').doc(TARGET_UID).get();
  expect(userSnap.data()?.sites).toContain(ASSIGN_SITE_ID);
});

test('POST /api/users/{uid}/remove-sites — removes siteIds via arrayRemove', async ({ request }) => {
  await request.post(`/api/users/${TARGET_UID}/assign-sites`, {
    headers: authHeaders(superKey),
    data: { siteIds: [ASSIGN_SITE_ID] },
  });

  const res = await request.post(`/api/users/${TARGET_UID}/remove-sites`, {
    headers: authHeaders(superKey),
    data: { siteIds: [ASSIGN_SITE_ID] },
  });
  expect(res.status()).toBe(200);

  const db = getAdminDb();
  const userSnap = await db.collection('users').doc(TARGET_UID).get();
  expect(userSnap.data()?.sites ?? []).not.toContain(ASSIGN_SITE_ID);
});

test('DELETE /api/users/{uid} — 409 orphan_sites when user owns sites without successorUid', async ({ request }) => {
  await seedUser(ORPHAN_OWNER_UID, 'admin');
  await seedSite(ORPHAN_SITE_ID, ORPHAN_OWNER_UID);

  const res = await request.delete(`/api/users/${ORPHAN_OWNER_UID}`, {
    headers: authHeaders(superKey, false),
  });
  expect(res.status()).toBe(409);
  const body = await res.json();
  expect(body.code).toBe('orphan_sites');
  expect(Array.isArray(body.ownedSites)).toBe(true);
  expect(body.ownedSites).toContain(ORPHAN_SITE_ID);
});
