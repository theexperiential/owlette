/**
 * api-sprint W5.4 — machine-api e2e (track 2A).
 *
 * Hits the machine command queue endpoints with a `machine=*:write|read` api
 * key. Reboot + screenshot are exercised — the public allowlist also includes
 * shutdown_machine but those three share a single handler so the dispatch
 * test covers all three branches.
 *
 * Verbs covered:
 *   - POST /api/sites/{s}/machines/{m}/commands
 *   - GET  /api/sites/{s}/machines/{m}/commands/{commandId}
 *
 * Negative paths:
 *   - 409 machine_offline when the machine doc has online=false
 *   - 403 scope_insufficient when the api key lacks machine:write
 */
import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { mintApiKey, revokeApiKey, authHeaders, type MintedApiKey } from '../../helpers/apiKey';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';

const SUFFIX = crypto.randomBytes(4).toString('hex');
const SITE_ID = `e2e-cmd-${SUFFIX}`;
const MACHINE_ID = `mach-${SUFFIX}`;
const OFFLINE_MACHINE_ID = `mach-offline-${SUFFIX}`;

let writeKey: MintedApiKey;
let readOnlyKey: MintedApiKey;

async function clearPending(machineId: string): Promise<void> {
  const db = getAdminDb();
  await db
    .collection('sites')
    .doc(SITE_ID)
    .collection('machines')
    .doc(machineId)
    .collection('commands')
    .doc('pending')
    .delete()
    .catch(() => undefined);
  await db
    .collection('sites')
    .doc(SITE_ID)
    .collection('machines')
    .doc(machineId)
    .collection('commands')
    .doc('completed')
    .delete()
    .catch(() => undefined);
}

test.beforeAll(async () => {
  const db = getAdminDb();
  await db
    .collection('sites')
    .doc(SITE_ID)
    .set({ name: SITE_ID, owner: 'admin-uid', timezone: 'UTC', createdAt: new Date() });
  await db
    .collection('users')
    .doc('admin-uid')
    .update({ sites: [...new Set(['site-A', SITE_ID])] });

  // Online + offline machines under the same site so we can hit both branches.
  await seedMachine(SITE_ID, MACHINE_ID);
  await seedMachine(SITE_ID, OFFLINE_MACHINE_ID);
  await db
    .collection('sites')
    .doc(SITE_ID)
    .collection('machines')
    .doc(OFFLINE_MACHINE_ID)
    .update({ online: false });

  writeKey = await mintApiKey({
    ownerUid: 'admin-uid',
    name: `e2e-cmd-write-${SUFFIX}`,
    scopes: [{ resource: 'machine', id: '*', permissions: ['read', 'write'] }],
  });
  readOnlyKey = await mintApiKey({
    ownerUid: 'admin-uid',
    name: `e2e-cmd-read-${SUFFIX}`,
    scopes: [{ resource: 'machine', id: '*', permissions: ['read'] }],
  });
});

test.afterAll(async () => {
  if (writeKey) await revokeApiKey(writeKey);
  if (readOnlyKey) await revokeApiKey(readOnlyKey);
  await Promise.all([clearPending(MACHINE_ID), clearPending(OFFLINE_MACHINE_ID)]);
});

test.beforeEach(async () => {
  await clearPending(MACHINE_ID);
  await clearPending(OFFLINE_MACHINE_ID);
});

test('POST /api/sites/{s}/machines/{m}/commands — dispatch reboot returns 202 + commandId', async ({ request }) => {
  const res = await request.post(`/api/sites/${SITE_ID}/machines/${MACHINE_ID}/commands`, {
    headers: authHeaders(writeKey),
    data: {
      type: 'reboot_machine',
      params: { delay_seconds: 30 },
      timeout_seconds: 60,
    },
  });
  expect(res.status()).toBe(202);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(typeof body.data?.commandId).toBe('string');
  expect(body.data.commandId).toMatch(/^cmd_/);
  expect(body.data.status).toBe('pending');

  // Firestore side-effect: a pending command landed.
  const db = getAdminDb();
  const pendingSnap = await db
    .collection('sites')
    .doc(SITE_ID)
    .collection('machines')
    .doc(MACHINE_ID)
    .collection('commands')
    .doc('pending')
    .get();
  expect(pendingSnap.exists).toBe(true);
  const cmd = pendingSnap.data()?.[body.data.commandId];
  expect(cmd?.type).toBe('reboot_machine');
});

test('POST + GET /api/sites/{s}/machines/{m}/commands/{commandId} — dispatch screenshot, then poll', async ({ request }) => {
  const dispatchRes = await request.post(`/api/sites/${SITE_ID}/machines/${MACHINE_ID}/commands`, {
    headers: authHeaders(writeKey),
    data: {
      type: 'capture_screenshot',
      params: { monitor: 'all' },
    },
  });
  expect(dispatchRes.status()).toBe(202);
  const dispatchBody = await dispatchRes.json();
  const commandId = dispatchBody.data.commandId;

  const pollRes = await request.get(
    `/api/sites/${SITE_ID}/machines/${MACHINE_ID}/commands/${commandId}`,
    { headers: authHeaders(readOnlyKey, false) },
  );
  expect(pollRes.status()).toBe(200);
  const pollBody = await pollRes.json();
  expect(pollBody.ok).toBe(true);
  expect(pollBody.data.commandId).toBe(commandId);
  expect(['pending', 'in_progress']).toContain(pollBody.data.status);
});

test('POST /api/sites/{s}/machines/{m}/commands — 409 machine_offline when machine.online=false', async ({ request }) => {
  const res = await request.post(
    `/api/sites/${SITE_ID}/machines/${OFFLINE_MACHINE_ID}/commands`,
    {
      headers: authHeaders(writeKey),
      data: { type: 'reboot_machine' },
    },
  );
  expect(res.status()).toBe(409);
  const body = await res.json();
  expect(body.code).toBe('machine_offline');
});

test('POST /api/sites/{s}/machines/{m}/commands — read-only key gets 403', async ({ request }) => {
  const res = await request.post(`/api/sites/${SITE_ID}/machines/${MACHINE_ID}/commands`, {
    headers: authHeaders(readOnlyKey),
    data: { type: 'reboot_machine' },
  });
  expect(res.status()).toBe(403);
  const body = await res.json();
  expect(body.code).toBe('scope_insufficient');
});
