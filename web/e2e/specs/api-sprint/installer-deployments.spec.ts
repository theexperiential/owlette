/**
 * installer-deploys-api e2e: the public scoped endpoints under
 * `/api/sites/{siteId}/deployments/*` driven by an `owk_test_*` api key,
 * asserting response shape + Firestore side-effects.
 *
 * One happy path per verb (list, create, get, retry, cancel, uninstall,
 * delete), plus: 403 scope_insufficient without `site:write`, 413 over_quota
 * past the per-site target cap, and idempotency replay of the cached body.
 */
import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { mintApiKey, revokeApiKey, authHeaders, type MintedApiKey } from '../../helpers/apiKey';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';

const SUFFIX = crypto.randomBytes(4).toString('hex');
const SITE_ID = `e2e-deploy-${SUFFIX}`;
const MACHINE_ID_A = `mach-a-${SUFFIX}`;
const MACHINE_ID_B = `mach-b-${SUFFIX}`;

let writeKey: MintedApiKey;
let readOnlyKey: MintedApiKey;

async function clearDeployments(): Promise<void> {
  const db = getAdminDb();
  const snap = await db.collection('sites').doc(SITE_ID).collection('deployments').get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

async function clearMachineCommands(machineId: string): Promise<void> {
  const db = getAdminDb();
  const ref = db
    .collection('sites')
    .doc(SITE_ID)
    .collection('machines')
    .doc(machineId)
    .collection('commands')
    .doc('pending');
  await ref.delete().catch(() => undefined);
}

test.beforeAll(async () => {
  // Isolated site so this doesn't collide with dispatch/create-deployment.spec.ts
  // on the canonical `site-A`.
  const db = getAdminDb();
  await db
    .collection('sites')
    .doc(SITE_ID)
    .set({ name: SITE_ID, owner: 'admin-uid', timezone: 'UTC', createdAt: new Date() });

  // Key auth doesn't need the membership row, but granting it keeps the seed
  // reusable for a session-cookie path.
  await db
    .collection('users')
    .doc('admin-uid')
    .update({ sites: [...new Set(['site-A', SITE_ID])] });

  await Promise.all([seedMachine(SITE_ID, MACHINE_ID_A), seedMachine(SITE_ID, MACHINE_ID_B)]);

  writeKey = await mintApiKey({
    ownerUid: 'admin-uid',
    name: `e2e-deploy-write-${SUFFIX}`,
    scopes: [{ resource: 'site', id: SITE_ID, permissions: ['read', 'write', 'admin'] }],
  });
  readOnlyKey = await mintApiKey({
    ownerUid: 'admin-uid',
    name: `e2e-deploy-read-${SUFFIX}`,
    scopes: [{ resource: 'site', id: SITE_ID, permissions: ['read'] }],
  });
});

test.afterAll(async () => {
  if (writeKey) await revokeApiKey(writeKey);
  if (readOnlyKey) await revokeApiKey(readOnlyKey);
  await clearDeployments();
  await Promise.all([clearMachineCommands(MACHINE_ID_A), clearMachineCommands(MACHINE_ID_B)]);

  // MUST undo the membership grant: leaving SITE_ID in admin-uid's `sites` makes
  // site auto-selection prefer it over `site-A` for every later spec, whose
  // seeds then never render (failed 9 co-run specs, 2026-08-12).
  const db = getAdminDb();
  const userRef = db.collection('users').doc('admin-uid');
  const snap = await userRef.get();
  const sites = ((snap.data()?.sites ?? []) as string[]).filter((s) => s !== SITE_ID);
  await userRef.update({ sites });
  await db.collection('sites').doc(SITE_ID).delete();
});

test.beforeEach(async () => {
  await clearDeployments();
  await Promise.all([clearMachineCommands(MACHINE_ID_A), clearMachineCommands(MACHINE_ID_B)]);
});

test('POST /api/sites/{s}/deployments — creates deployment + fans out install commands', async ({ request }) => {
  const installerUrl = `https://example.com/installer-${SUFFIX}.exe`;
  const res = await request.post(`/api/sites/${SITE_ID}/deployments`, {
    headers: authHeaders(writeKey),
    data: {
      name: `deploy-${SUFFIX}`,
      installer_name: `installer-${SUFFIX}.exe`,
      installer_url: installerUrl,
      silent_flags: '/SILENT /NORESTART',
      machines: [MACHINE_ID_A, MACHINE_ID_B],
    },
  });

  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(typeof body.deploymentId).toBe('string');
  expect(body.deploymentId).toMatch(/^deploy-\d+$/);
  expect(body.siteId).toBe(SITE_ID);
  expect(body.status).toBe('in_progress');
  expect(Array.isArray(body.targets)).toBe(true);
  expect(body.targets).toHaveLength(2);

  // Firestore side-effect: the deployment doc lists the right machines.
  const db = getAdminDb();
  const docSnap = await db
    .collection('sites')
    .doc(SITE_ID)
    .collection('deployments')
    .doc(body.deploymentId)
    .get();
  expect(docSnap.exists).toBe(true);
  expect(docSnap.data()?.installer_url).toBe(installerUrl);

  // Each machine got an install_software command queued.
  for (const machineId of [MACHINE_ID_A, MACHINE_ID_B]) {
    const pendingSnap = await db
      .collection('sites')
      .doc(SITE_ID)
      .collection('machines')
      .doc(machineId)
      .collection('commands')
      .doc('pending')
      .get();
    const pending = pendingSnap.exists ? Object.values(pendingSnap.data() ?? {}) : [];
    const installCmd = pending.find((c: unknown) => (c as { type?: string }).type === 'install_software');
    expect(installCmd).toBeDefined();
    expect((installCmd as { deployment_id?: string }).deployment_id).toBe(body.deploymentId);
  }
});

test('GET /api/sites/{s}/deployments — lists newest first, paginates', async ({ request }) => {
  // Seed directly so this doesn't depend on POST timing.
  const db = getAdminDb();
  const col = db.collection('sites').doc(SITE_ID).collection('deployments');
  const now = Date.now();
  await Promise.all([
    col.doc(`deploy-${now - 1000}`).set({
      name: 'older',
      installer_name: 'older.exe',
      installer_url: 'https://example.com/older.exe',
      silent_flags: '/S',
      targets: [],
      status: 'completed',
      createdAt: new Date(now - 1000),
      createdBy: 'admin-uid',
    }),
    col.doc(`deploy-${now}`).set({
      name: 'newer',
      installer_name: 'newer.exe',
      installer_url: 'https://example.com/newer.exe',
      silent_flags: '/S',
      targets: [],
      status: 'completed',
      createdAt: new Date(now),
      createdBy: 'admin-uid',
    }),
  ]);

  const res = await request.get(`/api/sites/${SITE_ID}/deployments?page_size=10`, {
    headers: authHeaders(readOnlyKey, false),
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.items)).toBe(true);
  expect(body.items.length).toBeGreaterThanOrEqual(2);
  // Newest first (createdAt desc).
  expect(body.items[0].name).toBe('newer');
  expect(typeof body.next_page_token).toBe('string');
});

test('GET /api/sites/{s}/deployments/{id} — returns full detail', async ({ request }) => {
  const db = getAdminDb();
  const id = `deploy-${Date.now()}`;
  await db
    .collection('sites')
    .doc(SITE_ID)
    .collection('deployments')
    .doc(id)
    .set({
      name: 'detail-test',
      installer_name: 'detail.exe',
      installer_url: 'https://example.com/detail.exe',
      silent_flags: '/S',
      targets: [{ machineId: MACHINE_ID_A, status: 'completed' }],
      status: 'completed',
      createdAt: new Date(),
      createdBy: 'admin-uid',
    });

  const res = await request.get(`/api/sites/${SITE_ID}/deployments/${id}`, {
    headers: authHeaders(readOnlyKey, false),
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.id).toBe(id);
  expect(body.siteId).toBe(SITE_ID);
  expect(body.name).toBe('detail-test');
  expect(body.targets).toHaveLength(1);
});

test('POST /api/sites/{s}/deployments/{id}/retry — re-queues failed targets', async ({ request }) => {
  const db = getAdminDb();
  const id = `deploy-${Date.now()}`;
  await db
    .collection('sites')
    .doc(SITE_ID)
    .collection('deployments')
    .doc(id)
    .set({
      name: 'retry-test',
      installer_name: 'retry.exe',
      installer_url: 'https://example.com/retry.exe',
      silent_flags: '/S',
      // A pinned checksum keeps the server's legacy self-heal (which streams the
      // installer URL) out of this test — retry stays network-free.
      sha256_checksum: 'ab'.repeat(32),
      targets: [
        { machineId: MACHINE_ID_A, status: 'failed', error: 'boom' },
        { machineId: MACHINE_ID_B, status: 'completed' },
      ],
      status: 'partial_failed',
      createdAt: new Date(),
      createdBy: 'admin-uid',
    });

  const res = await request.post(`/api/sites/${SITE_ID}/deployments/${id}/retry`, {
    headers: authHeaders(writeKey),
    data: {},
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.deploymentId).toBe(id);
  expect(body.retried).toBe(1);
  expect(body.machine_ids).toEqual([MACHINE_ID_A]);

  // Failed target reset to pending, new install command queued.
  const updated = await db
    .collection('sites')
    .doc(SITE_ID)
    .collection('deployments')
    .doc(id)
    .get();
  const targets = updated.data()?.targets as Array<{ machineId: string; status: string }>;
  const targetA = targets.find((t) => t.machineId === MACHINE_ID_A);
  expect(targetA?.status).toBe('pending');
});

test('POST /api/sites/{s}/deployments/{id}/cancel — cancels pending targets', async ({ request }) => {
  const db = getAdminDb();
  const id = `deploy-${Date.now()}`;
  await db
    .collection('sites')
    .doc(SITE_ID)
    .collection('deployments')
    .doc(id)
    .set({
      name: 'cancel-test',
      installer_name: 'cancel.exe',
      installer_url: 'https://example.com/cancel.exe',
      silent_flags: '/S',
      targets: [
        { machineId: MACHINE_ID_A, status: 'pending' },
        { machineId: MACHINE_ID_B, status: 'installing' },
      ],
      status: 'in_progress',
      createdAt: new Date(),
      createdBy: 'admin-uid',
    });

  const res = await request.post(`/api/sites/${SITE_ID}/deployments/${id}/cancel`, {
    headers: authHeaders(writeKey),
    data: {},
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.cancelled).toBe(1);
  expect(body.machine_ids).toEqual([MACHINE_ID_A]);
});

test('POST /api/sites/{s}/deployments/{id}/uninstall — site:admin queues uninstall', async ({ request }) => {
  const db = getAdminDb();
  const id = `deploy-${Date.now()}`;
  await db
    .collection('sites')
    .doc(SITE_ID)
    .collection('deployments')
    .doc(id)
    .set({
      name: 'uninstall-test',
      installer_name: 'uninstall.exe',
      installer_url: 'https://example.com/uninstall.exe',
      silent_flags: '/S',
      targets: [{ machineId: MACHINE_ID_A, status: 'completed' }],
      status: 'completed',
      createdAt: new Date(),
      createdBy: 'admin-uid',
    });

  const res = await request.post(`/api/sites/${SITE_ID}/deployments/${id}/uninstall`, {
    headers: authHeaders(writeKey),
    data: {},
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.queued).toBe(1);
  expect(body.machine_ids).toEqual([MACHINE_ID_A]);
});

test('DELETE /api/sites/{s}/deployments/{id} - deletes terminal deployment record', async ({ request }) => {
  const db = getAdminDb();
  const id = `deploy-${Date.now()}`;
  await db
    .collection('sites')
    .doc(SITE_ID)
    .collection('deployments')
    .doc(id)
    .set({
      name: 'delete-test',
      installer_name: 'delete.exe',
      installer_url: 'https://example.com/delete.exe',
      silent_flags: '/S',
      targets: [{ machineId: MACHINE_ID_A, status: 'completed' }],
      status: 'completed',
      createdAt: new Date(),
      createdBy: 'admin-uid',
    });

  const res = await request.delete(`/api/sites/${SITE_ID}/deployments/${id}`, {
    headers: authHeaders(writeKey),
    data: {},
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ deploymentId: id, siteId: SITE_ID, deleted: true });

  const deleted = await db
    .collection('sites')
    .doc(SITE_ID)
    .collection('deployments')
    .doc(id)
    .get();
  expect(deleted.exists).toBe(false);
});

test('POST /api/sites/{s}/deployments — read-only key gets 403 scope_insufficient', async ({ request }) => {
  const res = await request.post(`/api/sites/${SITE_ID}/deployments`, {
    headers: authHeaders(readOnlyKey),
    data: {
      name: 'should-fail',
      installer_name: 'x.exe',
      installer_url: 'https://example.com/x.exe',
      silent_flags: '/S',
      machines: [MACHINE_ID_A],
    },
  });
  expect(res.status()).toBe(403);
  const body = await res.json();
  // RFC 7807 problem+json — `code` is the stable error string.
  expect(body.code).toBe('scope_insufficient');
});

test('POST /api/sites/{s}/deployments — over_quota when targets exceed cap', async ({ request }) => {
  // Low quota so we can trip it without 100+ machine ids in the body.
  const db = getAdminDb();
  await db.collection('sites').doc(SITE_ID).update({ deployQuota: 1 });

  const res = await request.post(`/api/sites/${SITE_ID}/deployments`, {
    headers: authHeaders(writeKey),
    data: {
      name: 'too-many',
      installer_name: 'x.exe',
      installer_url: 'https://example.com/x.exe',
      silent_flags: '/S',
      machines: [MACHINE_ID_A, MACHINE_ID_B],
    },
  });

  expect(res.status()).toBe(413);
  const body = await res.json();
  expect(body.code).toBe('over_quota');

  // Reset the quota for downstream tests.
  await db.collection('sites').doc(SITE_ID).update({ deployQuota: 100 });
});

test('POST /api/sites/{s}/deployments — idempotency replay returns cached body', async ({ request }) => {
  const idempotencyKey = crypto.randomUUID();
  const payload = {
    name: `idempotent-${SUFFIX}`,
    installer_name: 'idem.exe',
    installer_url: 'https://example.com/idem.exe',
    silent_flags: '/S',
    machines: [MACHINE_ID_A],
  };
  const headers = {
    Authorization: `Bearer ${writeKey.rawKey}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey,
  };

  const first = await request.post(`/api/sites/${SITE_ID}/deployments`, {
    headers,
    data: payload,
  });
  expect(first.status()).toBe(201);
  const firstBody = await first.json();

  const replay = await request.post(`/api/sites/${SITE_ID}/deployments`, {
    headers,
    data: payload,
  });
  expect(replay.status()).toBe(201);
  const replayBody = await replay.json();
  // deploymentId is stamped from Date.now(), so a re-executed replay would
  // return a fresh id — matching ids prove the cache was served.
  expect(replayBody.deploymentId).toBe(firstBody.deploymentId);
});
