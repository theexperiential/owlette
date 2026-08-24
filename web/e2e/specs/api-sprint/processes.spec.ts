/**
 * Process-api e2e: every verb under `/api/sites/{s}/machines/{m}/processes/*`
 * (list, create, get, patch, delete, start, stop, kill, schedule) driven with a
 * `machine=*:write` api key, plus the 409 duplicate_process_name path.
 */
import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { mintApiKey, revokeApiKey, authHeaders, type MintedApiKey } from '../../helpers/apiKey';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';

const SUFFIX = crypto.randomBytes(4).toString('hex');
const SITE_ID = `e2e-proc-${SUFFIX}`;
const MACHINE_ID = `mach-${SUFFIX}`;

let writeKey: MintedApiKey;

async function clearProcessConfig(): Promise<void> {
  const db = getAdminDb();
  // The process list shares sites/{site}/machines/{machine}, so reset by writing
  // an empty list — deleting the doc would take the display hardware subdoc too.
  await db
    .collection('config')
    .doc(SITE_ID)
    .collection('machines')
    .doc(MACHINE_ID)
    .set({ processes: [] }, { merge: true });
}

async function clearMachineCommands(): Promise<void> {
  const db = getAdminDb();
  await db
    .collection('sites')
    .doc(SITE_ID)
    .collection('machines')
    .doc(MACHINE_ID)
    .collection('commands')
    .doc('pending')
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

  await seedMachine(SITE_ID, MACHINE_ID);

  writeKey = await mintApiKey({
    ownerUid: 'admin-uid',
    name: `e2e-process-${SUFFIX}`,
    scopes: [{ resource: 'machine', id: '*', permissions: ['read', 'write'] }],
  });
});

test.afterAll(async () => {
  if (writeKey) await revokeApiKey(writeKey);
  await clearProcessConfig();
  await clearMachineCommands();
});

test.beforeEach(async () => {
  await clearProcessConfig();
  await clearMachineCommands();
});

test('GET /api/sites/{s}/machines/{m}/processes — empty list when none configured', async ({ request }) => {
  const res = await request.get(`/api/sites/${SITE_ID}/machines/${MACHINE_ID}/processes`, {
    headers: authHeaders(writeKey, false),
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(Array.isArray(body.data.processes)).toBe(true);
});

test('POST /api/sites/{s}/machines/{m}/processes — creates a process with server-generated id', async ({ request }) => {
  const name = `proc-${SUFFIX}-create`;
  const res = await request.post(`/api/sites/${SITE_ID}/machines/${MACHINE_ID}/processes`, {
    headers: authHeaders(writeKey),
    data: { name, exe_path: 'C:/test.exe' },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(typeof body.data.processId).toBe('string');
});

test('GET /api/sites/{s}/machines/{m}/processes/{pid} — returns single process detail', async ({ request }) => {
  const name = `proc-${SUFFIX}-detail`;
  const create = await request.post(
    `/api/sites/${SITE_ID}/machines/${MACHINE_ID}/processes`,
    { headers: authHeaders(writeKey), data: { name, exe_path: 'C:/test.exe' } },
  );
  expect(create.status()).toBe(201);
  const { data: { processId } } = await create.json();

  const res = await request.get(
    `/api/sites/${SITE_ID}/machines/${MACHINE_ID}/processes/${processId}`,
    { headers: authHeaders(writeKey, false) },
  );
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.data.processId).toBe(processId);
  expect(body.data.name).toBe(name);
});

test('PATCH /api/sites/{s}/machines/{m}/processes/{pid} — partial update', async ({ request }) => {
  const create = await request.post(
    `/api/sites/${SITE_ID}/machines/${MACHINE_ID}/processes`,
    {
      headers: authHeaders(writeKey),
      data: { name: `proc-${SUFFIX}-patch`, exe_path: 'C:/test.exe' },
    },
  );
  const { data: { processId } } = await create.json();

  const res = await request.patch(
    `/api/sites/${SITE_ID}/machines/${MACHINE_ID}/processes/${processId}`,
    {
      headers: authHeaders(writeKey),
      data: { priority: 'High' },
    },
  );
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.data.processId).toBe(processId);
});

test('DELETE /api/sites/{s}/machines/{m}/processes/{pid} — removes from config', async ({ request }) => {
  const create = await request.post(
    `/api/sites/${SITE_ID}/machines/${MACHINE_ID}/processes`,
    {
      headers: authHeaders(writeKey),
      data: { name: `proc-${SUFFIX}-del`, exe_path: 'C:/test.exe' },
    },
  );
  const { data: { processId } } = await create.json();

  const res = await request.delete(
    `/api/sites/${SITE_ID}/machines/${MACHINE_ID}/processes/${processId}`,
    { headers: authHeaders(writeKey, false) },
  );
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.data.alreadyDeleted === false || body.data.alreadyDeleted === undefined).toBe(true);
});

test('POST /api/sites/{s}/machines/{m}/processes/{pid}/start — queues start_process command', async ({ request }) => {
  const create = await request.post(
    `/api/sites/${SITE_ID}/machines/${MACHINE_ID}/processes`,
    {
      headers: authHeaders(writeKey),
      data: { name: `proc-${SUFFIX}-start`, exe_path: 'C:/test.exe' },
    },
  );
  const { data: { processId } } = await create.json();

  const res = await request.post(
    `/api/sites/${SITE_ID}/machines/${MACHINE_ID}/processes/${processId}/start`,
    { headers: authHeaders(writeKey), data: {} },
  );
  expect(res.status()).toBe(202);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(typeof body.data.commandId).toBe('string');
});

test('POST /api/sites/{s}/machines/{m}/processes/{pid}/stop — queues stop_process command', async ({ request }) => {
  const create = await request.post(
    `/api/sites/${SITE_ID}/machines/${MACHINE_ID}/processes`,
    {
      headers: authHeaders(writeKey),
      data: { name: `proc-${SUFFIX}-stop`, exe_path: 'C:/test.exe' },
    },
  );
  const { data: { processId } } = await create.json();

  const res = await request.post(
    `/api/sites/${SITE_ID}/machines/${MACHINE_ID}/processes/${processId}/stop`,
    { headers: authHeaders(writeKey), data: {} },
  );
  expect(res.status()).toBe(202);
  const body = await res.json();
  expect(body.ok).toBe(true);
});

test('POST /api/sites/{s}/machines/{m}/processes/{pid}/kill — queues kill_process command', async ({ request }) => {
  const create = await request.post(
    `/api/sites/${SITE_ID}/machines/${MACHINE_ID}/processes`,
    {
      headers: authHeaders(writeKey),
      data: { name: `proc-${SUFFIX}-kill`, exe_path: 'C:/test.exe' },
    },
  );
  const { data: { processId } } = await create.json();

  const res = await request.post(
    `/api/sites/${SITE_ID}/machines/${MACHINE_ID}/processes/${processId}/kill`,
    { headers: authHeaders(writeKey), data: {} },
  );
  expect(res.status()).toBe(202);
  const body = await res.json();
  expect(body.ok).toBe(true);
});

test('POST /api/sites/{s}/machines/{m}/processes/{pid}/schedule — updates schedule mode', async ({ request }) => {
  const create = await request.post(
    `/api/sites/${SITE_ID}/machines/${MACHINE_ID}/processes`,
    {
      headers: authHeaders(writeKey),
      data: { name: `proc-${SUFFIX}-sched`, exe_path: 'C:/test.exe' },
    },
  );
  const { data: { processId } } = await create.json();

  const res = await request.post(
    `/api/sites/${SITE_ID}/machines/${MACHINE_ID}/processes/${processId}/schedule`,
    { headers: authHeaders(writeKey), data: { mode: 'always' } },
  );
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.data.mode).toBe('always');
});

test('POST /api/sites/{s}/machines/{m}/processes — 409 duplicate_process_name on collision', async ({ request }) => {
  const name = `proc-${SUFFIX}-dup`;
  // First create.
  const first = await request.post(`/api/sites/${SITE_ID}/machines/${MACHINE_ID}/processes`, {
    headers: authHeaders(writeKey),
    data: { name, exe_path: 'C:/a.exe' },
  });
  expect(first.status()).toBe(201);

  // Second with same name should collide.
  const dupe = await request.post(`/api/sites/${SITE_ID}/machines/${MACHINE_ID}/processes`, {
    headers: authHeaders(writeKey),
    data: { name, exe_path: 'C:/b.exe' },
  });
  // processConfig raises ProcessConfigError(409, 'duplicate_process_name').
  expect(dupe.status()).toBe(409);
  const body = await dupe.json();
  expect(body.code).toBe('duplicate_process_name');
});
