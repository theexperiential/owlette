import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { FieldValue } from 'firebase-admin/firestore';
import {
  authHeaders,
  mintApiKey,
  revokeApiKey,
  type MintedApiKey,
} from '../../helpers/apiKey';
import { getAdminDb } from '../../helpers/emulator';
import { seedChunks, seedMachine } from '../../helpers/seed';

const SUFFIX = crypto.randomBytes(4).toString('hex');
const SITE_ID = `site-smoke-${SUFFIX}`;
const MACHINE_ID = `mach-${SUFFIX}`;
const SOURCE_ROOST_ID = `rst_smoke_src_${SUFFIX}`;
const TARGET_ROOST_ID = `rst_smoke_tgt_${SUFFIX}`;
const PRESENT_CHUNK = '1'.repeat(64);
const MISSING_CHUNK = '2'.repeat(64);
const ROOST_VERSION = '2026-04-22';

let key: MintedApiKey | null = null;

function smokeHeaders(idempotencyKey: string | false = crypto.randomUUID()): Record<string, string> {
  if (!key) throw new Error('smoke API key has not been minted');
  return {
    ...authHeaders(key, idempotencyKey),
    'Roost-Version': ROOST_VERSION,
  };
}

function minimalVersionEnvelope() {
  return {
    schemaVersion: 2,
    mediaType: 'application/vnd.owlette.version.v1+json',
    config: {},
    files: [
      {
        path: 'content/main.txt',
        size: 4096,
        chunks: [{ hash: PRESENT_CHUNK, size: 4096 }],
      },
    ],
  };
}

test.describe.serial('public API smoke', () => {
  test.beforeAll(async () => {
    const db = getAdminDb();
    await db.collection('sites').doc(SITE_ID).set({
      name: `Public API Smoke ${SUFFIX}`,
      owner: 'admin-uid',
      timezone: 'UTC',
      createdAt: new Date(),
    });
    await db.collection('users').doc('admin-uid').set(
      { sites: FieldValue.arrayUnion(SITE_ID) },
      { merge: true },
    );
    await seedMachine(SITE_ID, MACHINE_ID);
    await seedChunks(SITE_ID, [PRESENT_CHUNK]);

    key = await mintApiKey({
      ownerUid: 'admin-uid',
      name: `public-api-smoke-${SUFFIX}`,
      scopes: [
        { resource: 'site', id: SITE_ID, permissions: ['read', 'write'] },
        { resource: 'machine', id: '*', permissions: ['read', 'write'] },
        { resource: 'roost', id: '*', permissions: ['read', 'write', 'deploy', 'rollback'] },
      ],
    });
  });

  test.afterAll(async () => {
    const db = getAdminDb();
    if (key) await revokeApiKey(key).catch(() => undefined);
    await Promise.all([
      db.collection('siteChunks').doc(PRESENT_CHUNK).delete().catch(() => undefined),
      db.collection('sites').doc(SITE_ID).delete().catch(() => undefined),
      db.collection('users').doc('admin-uid').set(
        { sites: FieldValue.arrayRemove(SITE_ID) },
        { merge: true },
      ).catch(() => undefined),
    ]);
  });

  test('auth and read endpoints work with a scoped API key', async ({ request }) => {
    const unauth = await request.get('/api/whoami');
    expect(unauth.status()).toBe(401);
    expect(unauth.headers()['content-type']).toContain('application/problem+json');

    const whoami = await request.get('/api/whoami', {
      headers: smokeHeaders(false),
    });
    expect(whoami.status()).toBe(200);
    const identity = await whoami.json();
    expect(identity).toMatchObject({
      userId: 'admin-uid',
      role: 'admin',
      primarySiteId: SITE_ID,
      key: {
        keyId: key?.keyId,
        environment: 'test',
        isLegacy: false,
      },
    });

    const roosts = await request.get(`/api/roosts?siteId=${SITE_ID}&limit=10`, {
      headers: smokeHeaders(false),
    });
    expect(roosts.status()).toBe(200);
    const body = await roosts.json();
    expect(Array.isArray(body.roosts)).toBe(true);
    expect(body.next_page_token).toEqual(expect.any(String));
  });

  test('create, update, read, and delete a roost shell', async ({ request }) => {
    const create = await request.post('/api/roosts', {
      headers: smokeHeaders(),
      data: {
        siteId: SITE_ID,
        roostId: SOURCE_ROOST_ID,
        name: 'Smoke Source',
        targets: [MACHINE_ID],
      },
    });
    expect(create.status()).toBe(201);
    await expect(create.json()).resolves.toMatchObject({
      roostId: SOURCE_ROOST_ID,
      siteId: SITE_ID,
      name: 'Smoke Source',
      targets: [MACHINE_ID],
    });

    const patch = await request.patch(`/api/roosts/${SOURCE_ROOST_ID}`, {
      headers: smokeHeaders(),
      data: {
        siteId: SITE_ID,
        name: 'Smoke Source Updated',
        extractPath: '~/Documents/Owlette Smoke',
      },
    });
    expect(patch.status()).toBe(200);

    const detail = await request.get(`/api/roosts/${SOURCE_ROOST_ID}?siteId=${SITE_ID}`, {
      headers: smokeHeaders(false),
    });
    expect(detail.status()).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      roostId: SOURCE_ROOST_ID,
      name: 'Smoke Source Updated',
      extractPath: '~/Documents/Owlette Smoke',
    });

    const remove = await request.delete(`/api/roosts/${SOURCE_ROOST_ID}?siteId=${SITE_ID}`, {
      headers: smokeHeaders(),
    });
    expect(remove.status()).toBe(200);
    await expect(remove.json()).resolves.toMatchObject({
      roostId: SOURCE_ROOST_ID,
      softDeleted: true,
    });
  });

  test('dispatches one async machine command', async ({ request }) => {
    const dispatch = await request.post(`/api/sites/${SITE_ID}/machines/${MACHINE_ID}/commands`, {
      headers: smokeHeaders(),
      data: {
        type: 'reboot_machine',
        params: { delay_seconds: 15 },
        timeout_seconds: 60,
      },
    });
    expect(dispatch.status()).toBe(202);
    const body = await dispatch.json();
    const commandId = body.data?.commandId;
    expect(commandId).toMatch(/^cmd_/);
    expect(body.data?.status).toBe('pending');

    const pending = await getAdminDb()
      .collection('sites')
      .doc(SITE_ID)
      .collection('machines')
      .doc(MACHINE_ID)
      .collection('commands')
      .doc('pending')
      .get();
    expect(pending.exists).toBe(true);
    expect(pending.data()?.[commandId]?.type).toBe('reboot_machine');
  });

  test('publishes a roost version and mounts an existing chunk', async ({ request }) => {
    for (const [roostId, name] of [
      [SOURCE_ROOST_ID, 'Chunk Source'],
      [TARGET_ROOST_ID, 'Chunk Target'],
    ] as const) {
      const create = await request.post('/api/roosts', {
        headers: smokeHeaders(),
        data: { siteId: SITE_ID, roostId, name, targets: [MACHINE_ID] },
      });
      expect([201, 409]).toContain(create.status());
    }

    const check = await request.post('/api/chunks/check', {
      headers: smokeHeaders(),
      data: {
        siteId: SITE_ID,
        hashes: [PRESENT_CHUNK, MISSING_CHUNK],
      },
    });
    expect(check.status()).toBe(200);
    await expect(check.json()).resolves.toEqual({ missing: [MISSING_CHUNK] });

    const publish = await request.post(`/api/roosts/${SOURCE_ROOST_ID}/versions`, {
      headers: smokeHeaders(),
      data: {
        siteId: SITE_ID,
        version: minimalVersionEnvelope(),
        description: 'public api smoke publish',
        targets: [MACHINE_ID],
      },
    });
    expect(publish.status()).toBe(201);
    const published = await publish.json();
    expect(published.versionNumber).toBeGreaterThanOrEqual(1);
    expect(published.currentVersionId).toEqual(published.versionId);

    const versions = await request.get(
      `/api/roosts/${SOURCE_ROOST_ID}/versions?siteId=${SITE_ID}&limit=10`,
      { headers: smokeHeaders(false) },
    );
    expect(versions.status()).toBe(200);
    const versionList = await versions.json();
    expect(versionList.versions.map((v: { versionId: string }) => v.versionId))
      .toContain(published.versionId);

    const mount = await request.post(
      `/api/chunks/${PRESENT_CHUNK}/mount?siteId=${SITE_ID}&from=${SOURCE_ROOST_ID}&to=${TARGET_ROOST_ID}`,
      { headers: smokeHeaders() },
    );
    expect(mount.status()).toBe(201);
    await expect(mount.json()).resolves.toMatchObject({
      digest: PRESENT_CHUNK,
      siteId: SITE_ID,
      from: SOURCE_ROOST_ID,
      to: TARGET_ROOST_ID,
      mounted: true,
      zeroByte: true,
    });
  });
});
