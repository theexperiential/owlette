/**
 * chat-api e2e — hits the chat conversation endpoints with a `chat=<siteId>:write` api key.
 *
 * DELIBERATELY still on `/api/cortex/*`. The hoot rename made `/api/hoot/conversations*` canonical
 * and left thin re-export routes at every `/api/cortex/*` path for the shipped `@owlette/cli`, the
 * SDKs, and pinned fleet agents. This spec is the regression gate on that back-compat surface —
 * do NOT "modernize" these URLs; add a hoot-path spec alongside if you want both.
 *
 * One happy path each for GET/POST /conversations, PATCH/DELETE/POST
 * /conversations/{conversationId}.
 *
 * The send endpoint goes through `runHootStream`, which 503s when the target machine is offline.
 * No real LLM completion is needed: either `text/event-stream` or a `cortex_unavailable`
 * problem+json proves routing + auth + the idempotency wrapper ran.
 */
import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { mintApiKey, revokeApiKey, authHeaders, type MintedApiKey } from '../../helpers/apiKey';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';

const SUFFIX = crypto.randomBytes(4).toString('hex');
const SITE_ID = `e2e-chat-${SUFFIX}`;
const MACHINE_ID = `mach-${SUFFIX}`;

let writeKey: MintedApiKey;

async function clearConversations(): Promise<void> {
  const db = getAdminDb();
  const snap = await db
    .collection('chat_conversations')
    .where('siteId', '==', SITE_ID)
    .get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
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
    name: `e2e-chat-${SUFFIX}`,
    scopes: [{ resource: 'chat', id: SITE_ID, permissions: ['read', 'write'] }],
  });
});

test.afterAll(async () => {
  if (writeKey) await revokeApiKey(writeKey);
  await clearConversations();
});

test.beforeEach(async () => {
  await clearConversations();
});

test('POST /api/cortex/conversations — creates a conversation', async ({ request }) => {
  const res = await request.post('/api/cortex/conversations', {
    headers: authHeaders(writeKey),
    data: { siteId: SITE_ID, title: `e2e-${SUFFIX}` },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(typeof body.data.conversationId).toBe('string');
  expect(body.data.siteId).toBe(SITE_ID);

  const db = getAdminDb();
  const docSnap = await db
    .collection('chat_conversations')
    .doc(body.data.conversationId)
    .get();
  expect(docSnap.exists).toBe(true);
});

test('GET /api/cortex/conversations — lists conversations the caller can access', async ({ request }) => {
  const db = getAdminDb();
  const now = Date.now();
  await Promise.all(
    [1, 2].map((i) =>
      db
        .collection('chat_conversations')
        .doc(`conv_${SUFFIX}_${i}`)
        .set({
          conversationId: `conv_${SUFFIX}_${i}`,
          siteId: SITE_ID,
          ownerUid: 'admin-uid',
          title: `seed-${i}`,
          createdAt: new Date(now + i),
          updatedAt: new Date(now + i),
          messages: [],
        }),
    ),
  );

  const res = await request.get(`/api/cortex/conversations?page_size=50`, {
    headers: authHeaders(writeKey, false),
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(Array.isArray(body.data.conversations)).toBe(true);
  const ids = body.data.conversations.map((c: { conversationId: string }) => c.conversationId);
  expect(ids).toEqual(expect.arrayContaining([`conv_${SUFFIX}_1`, `conv_${SUFFIX}_2`]));
});

test('PATCH /api/cortex/conversations/{conversationId} — renames title', async ({ request }) => {
  const create = await request.post('/api/cortex/conversations', {
    headers: authHeaders(writeKey),
    data: { siteId: SITE_ID, title: 'before' },
  });
  const { data: { conversationId } } = await create.json();

  const res = await request.patch(`/api/cortex/conversations/${conversationId}`, {
    headers: authHeaders(writeKey),
    data: { title: 'after' },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.data.title).toBe('after');
});

test('DELETE /api/cortex/conversations/{conversationId} — soft deletes', async ({ request }) => {
  const create = await request.post('/api/cortex/conversations', {
    headers: authHeaders(writeKey),
    data: { siteId: SITE_ID, title: 'doomed' },
  });
  const { data: { conversationId } } = await create.json();

  const res = await request.delete(`/api/cortex/conversations/${conversationId}`, {
    headers: authHeaders(writeKey, false),
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.data.conversationId).toBe(conversationId);

  const db = getAdminDb();
  const docSnap = await db.collection('chat_conversations').doc(conversationId).get();
  expect(typeof docSnap.data()?.deletedAt !== 'undefined').toBe(true);
});

test('POST /api/cortex/conversations/{conversationId} — SSE response when streaming, problem+json when upstream unavailable', async ({ request }) => {
  const create = await request.post('/api/cortex/conversations', {
    headers: authHeaders(writeKey),
    data: { siteId: SITE_ID, machineId: MACHINE_ID, title: 'send-test' },
  });
  expect(create.status()).toBe(201);
  const { data: { conversationId } } = await create.json();

  const res = await request.post(`/api/cortex/conversations/${conversationId}`, {
    headers: authHeaders(writeKey),
    data: { role: 'user', content: 'hello, are you online?' },
  });

  // Either outcome proves auth + idempotency ran and the request reached the hoot pipeline:
  // 200 `text/event-stream`, or 503 problem+json with code `cortex_unavailable`.
  const status = res.status();
  expect([200, 423, 503]).toContain(status);
  const ct = res.headers()['content-type'] || '';
  if (status === 200) {
    expect(
      ct.includes('text/event-stream') ||
        (ct.includes('text/plain') && res.headers()['x-vercel-ai-data-stream'] === 'v1'),
    ).toBe(true);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
  } else {
    const body = await res.json();
    expect(['cortex_unavailable']).toContain(body.code);
  }
});
