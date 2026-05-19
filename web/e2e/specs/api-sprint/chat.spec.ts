/**
 * api-sprint W5.4 — chat-api e2e (track 3A / cortex noun).
 *
 * Hits the chat conversation endpoints with a `chat=<siteId>:write` api key.
 *
 * Verbs covered (≥1 happy-path each):
 *   - GET    /api/chat
 *   - POST   /api/chat/new
 *   - PATCH  /api/chat/{conversationId}
 *   - DELETE /api/chat/{conversationId}
 *   - POST   /api/chat/{conversationId}    (SSE stream — see notes)
 *
 * Notes on the streaming case:
 *   The send endpoint funnels through `runCortexStream`, which returns 503
 *   when the targeted machine is offline (or in our case, has no
 *   `cortexStatus.online`). For the e2e we don't need a real LLM completion —
 *   we only assert the route returns either a streaming response (Content-
 *   Type starting with `text/event-stream`) when the path is healthy, or a
 *   `cortex_unavailable` problem+json when the upstream is unreachable. Both
 *   prove the routing + auth + idempotency wrapper executed.
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

test('POST /api/chat/new — creates a conversation', async ({ request }) => {
  const res = await request.post('/api/chat/new', {
    headers: authHeaders(writeKey),
    data: { siteId: SITE_ID, title: `e2e-${SUFFIX}` },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(typeof body.data.conversationId).toBe('string');
  expect(body.data.siteId).toBe(SITE_ID);

  // Firestore side-effect: doc exists.
  const db = getAdminDb();
  const docSnap = await db
    .collection('chat_conversations')
    .doc(body.data.conversationId)
    .get();
  expect(docSnap.exists).toBe(true);
});

test('GET /api/chat — lists conversations the caller can access', async ({ request }) => {
  // Seed a couple of conversations directly.
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

  const res = await request.get(`/api/chat?page_size=50`, {
    headers: authHeaders(writeKey, false),
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(Array.isArray(body.data.conversations)).toBe(true);
  // The list should include our seeded conversations.
  const ids = body.data.conversations.map((c: { conversationId: string }) => c.conversationId);
  expect(ids).toEqual(expect.arrayContaining([`conv_${SUFFIX}_1`, `conv_${SUFFIX}_2`]));
});

test('PATCH /api/chat/{conversationId} — renames title', async ({ request }) => {
  const create = await request.post('/api/chat/new', {
    headers: authHeaders(writeKey),
    data: { siteId: SITE_ID, title: 'before' },
  });
  const { data: { conversationId } } = await create.json();

  const res = await request.patch(`/api/chat/${conversationId}`, {
    headers: authHeaders(writeKey),
    data: { title: 'after' },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.data.title).toBe('after');
});

test('DELETE /api/chat/{conversationId} — soft deletes', async ({ request }) => {
  const create = await request.post('/api/chat/new', {
    headers: authHeaders(writeKey),
    data: { siteId: SITE_ID, title: 'doomed' },
  });
  const { data: { conversationId } } = await create.json();

  const res = await request.delete(`/api/chat/${conversationId}`, {
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

test('POST /api/chat/{conversationId} — SSE response when streaming, problem+json when upstream unavailable', async ({ request }) => {
  const create = await request.post('/api/chat/new', {
    headers: authHeaders(writeKey),
    data: { siteId: SITE_ID, machineId: MACHINE_ID, title: 'send-test' },
  });
  expect(create.status()).toBe(201);
  const { data: { conversationId } } = await create.json();

  const res = await request.post(`/api/chat/${conversationId}`, {
    headers: authHeaders(writeKey),
    data: { role: 'user', content: 'hello, are you online?' },
  });

  // Two valid outcomes prove the route's auth + idempotency executed and the
  // request was forwarded into the cortex pipeline:
  //   - 200 with a `text/event-stream` body (LLM is reachable)
  //   - 503 with a problem+json body whose code is `cortex_unavailable`
  //     (machine offline / cortex disabled / no LLM creds in test env)
  const status = res.status();
  expect([200, 423, 503]).toContain(status);
  const ct = res.headers()['content-type'] || '';
  if (status === 200) {
    expect(
      ct.includes('text/event-stream') ||
        (ct.includes('text/plain') && res.headers()['x-vercel-ai-data-stream'] === 'v1'),
    ).toBe(true);
    // Drain the stream body to confirm the framing.
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
  } else {
    const body = await res.json();
    expect(['cortex_unavailable']).toContain(body.code);
  }
});
