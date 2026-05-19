/** @jest-environment node */

/**
 * api-sprint wave 3 — track 3A (cortex-api / chat noun).
 *
 * Http-shape coverage for the public Cortex conversation endpoints:
 *
 *   GET    /api/cortex/conversations
 *   POST   /api/cortex/conversations
 *   POST   /api/cortex/conversations/{conversationId}      (send + stream)
 *   PATCH  /api/cortex/conversations/{conversationId}      (rename)
 *   DELETE /api/cortex/conversations/{conversationId}      (soft-delete)
 *
 * Each verb is covered for scope-pass + scope-fail + verb-specific happy /
 * error paths (validation, 404, idempotency replay, sse smoke). Storage is
 * mocked at the helper boundary (`chatStorage.server`) so the pure routing
 * + auth + audit logic is what's exercised; the storage helpers themselves
 * have their own jest unit tests in `lib/__tests__/chatStorage.test.ts`.
 */

import { NextRequest } from 'next/server';

/* -------------------------------------------------------------------------- */
/*  Mocks                                                                     */
/* -------------------------------------------------------------------------- */

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockRequireChatAuth = jest.fn();
const mockRequireChatAuthDefault = () => ({
  ok: true as const,
  userId: 'user-1',
  auth: { userId: 'user-1', keyContext: null },
  scopeCheck: { isLegacy: false },
});

jest.mock('@/app/api/_shared', () => {
  const actual = jest.requireActual('@/app/api/_shared');
  return {
    ...actual,
    requireChatAuthAndScope: (...a: unknown[]) => mockRequireChatAuth(...a),
  };
});

const mockWithIdempotency = jest.fn(
  async (_req: unknown, _ctx: unknown, _body: unknown, fn: () => Promise<unknown>) => fn(),
);
jest.mock('@/lib/idempotency', () => ({
  withIdempotency: (...args: unknown[]) =>
    mockWithIdempotency(
      ...(args as [unknown, unknown, unknown, () => Promise<unknown>]),
    ),
}));

const mockEmitMutation = jest.fn();
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
  emitApiKeyUsed: jest.fn(),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

// Storage helper mocks. `getConversation` is the chokepoint: routes call it
// to discover the conversation's siteId before doing the auth+scope check.
const mockGetConversation = jest.fn();
const mockCreateConversation = jest.fn();
const mockListConversations = jest.fn();
const mockAppendMessage = jest.fn();
const mockSoftDelete = jest.fn();
const mockRename = jest.fn();
jest.mock('@/lib/chatStorage.server', () => {
  const actual = jest.requireActual('@/lib/chatStorage.server');
  return {
    ...actual,
    getConversation: (...a: unknown[]) => mockGetConversation(...a),
    createConversation: (...a: unknown[]) => mockCreateConversation(...a),
    listConversations: (...a: unknown[]) => mockListConversations(...a),
    appendMessage: (...a: unknown[]) => mockAppendMessage(...a),
    softDeleteConversation: (...a: unknown[]) => mockSoftDelete(...a),
    renameConversation: (...a: unknown[]) => mockRename(...a),
    // ChatStorageError is exported from the actual module via the spread.
  };
});

// Cortex stream is mocked at the module boundary so we don't need a real LLM.
const mockRunCortexStream = jest.fn();
jest.mock('@/lib/cortexStream.server', () => {
  const actual = jest.requireActual('@/lib/cortexStream.server');
  return {
    ...actual,
    runCortexStream: (...a: unknown[]) => mockRunCortexStream(...a),
  };
});

// User+site reads for the GET /api/cortex/conversations list filter.
const mockGetUserSiteIds = jest.fn();
jest.mock('@/lib/apiHelpers.server', () => {
  const actual = jest.requireActual('@/lib/apiHelpers.server');
  return {
    ...actual,
    getUserSiteIds: (...a: unknown[]) => mockGetUserSiteIds(...a),
  };
});

const mockResolveAuth = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
  };
});

// Firebase admin: GET list uses it for the owned-sites lookup; the per-conversation
// routes use it for the superadmin override on the conversation-owner check.
// Default the user-doc lookup to "no role" so the superadmin escape hatch is closed.
const mockOwnedSitesGet = jest.fn().mockResolvedValue({ docs: [] });
const mockUserDocGet = jest.fn().mockResolvedValue({
  exists: false,
  data: () => null,
});
jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => {
      if (name === 'users') {
        return { doc: () => ({ get: mockUserDocGet }) };
      }
      return { where: () => ({ get: mockOwnedSitesGet }) };
    },
  }),
  getAdminAuth: () => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')),
  }),
}));

import { Timestamp } from 'firebase-admin/firestore';

import {
  GET as listGET,
  POST as newPOST,
} from '@/app/api/cortex/conversations/route';
import {
  POST as sendPOST,
  PATCH as renamePATCH,
  DELETE as deleteDELETE,
} from '@/app/api/cortex/conversations/[conversationId]/route';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

const SITE = 'site-alpha';
const CONV = 'conv_abc123';

function jsonReq(
  url: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers } as HeadersInit,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function ctx(conversationId = CONV) {
  return { params: Promise.resolve({ conversationId }) };
}

function mockConversation(overrides: Record<string, unknown> = {}) {
  const now = Timestamp.now();
  return {
    conversationId: CONV,
    title: 'fixture chat',
    siteId: SITE,
    ownerUid: 'user-1',
    createdAt: now,
    updatedAt: now,
    messages: [],
    messageCount: 0,
    ...overrides,
  };
}

function makeProblemResponse(status: number, code: string, title: string) {
  return new Response(
    JSON.stringify({ type: 'about:blank', title, status, code, detail: title }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  ) as unknown as import('next/server').NextResponse;
}

function authForbidden() {
  mockRequireChatAuth.mockResolvedValueOnce({
    ok: false,
    response: makeProblemResponse(403, 'scope_insufficient', 'forbidden'),
  });
}

function authUnauthorized() {
  mockRequireChatAuth.mockResolvedValueOnce({
    ok: false,
    response: makeProblemResponse(401, 'unauthorized', 'unauthorized'),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireChatAuth.mockResolvedValue(mockRequireChatAuthDefault());
  mockResolveAuth.mockResolvedValue({ userId: 'user-1', keyContext: null });
  mockGetUserSiteIds.mockResolvedValue([SITE]);
  mockOwnedSitesGet.mockResolvedValue({ docs: [] });
  mockWithIdempotency.mockImplementation(async (_req, _ctx, _body, fn) => fn());
  mockGetConversation.mockResolvedValue(mockConversation());
  mockCreateConversation.mockImplementation(async (input: { siteId: string; ownerUid: string; machineId?: string; title?: string; initialMessages?: unknown[] }) => {
    const now = Timestamp.now();
    return {
      conversationId: CONV,
      title: input.title?.trim() || 'untitled chat',
      siteId: input.siteId,
      ownerUid: input.ownerUid,
      machineId: input.machineId,
      createdAt: now,
      updatedAt: now,
      messages: (input.initialMessages ?? []).map((m: unknown) => ({
        ...(m as Record<string, unknown>),
        timestamp: now,
      })),
      messageCount: (input.initialMessages ?? []).length,
    };
  });
  mockListConversations.mockResolvedValue({
    conversations: [mockConversation()],
    nextPageToken: '',
  });
  mockAppendMessage.mockResolvedValue({ messageCount: 1, spilled: false });
  mockSoftDelete.mockResolvedValue({ alreadyDeleted: false, deletedAt: Timestamp.now() });
  mockRename.mockImplementation(async (_id: string, title: unknown) => ({
    title: typeof title === 'string' ? title.trim() : 'untitled chat',
  }));

  // Default: cortex returns a tiny synthetic stream
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('0:"hello"\n'));
      controller.enqueue(encoder.encode('d:{"finishReason":"stop"}\n'));
      controller.close();
    },
  });
  mockRunCortexStream.mockResolvedValue({
    ok: true,
    response: new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Vercel-AI-Data-Stream': 'v1',
      },
    }),
  });
});

/* ========================================================================== */
/*  GET /api/cortex/conversations - list                                      */
/* ========================================================================== */

describe('GET /api/cortex/conversations', () => {
  it('200 with conversations + pagination shape', async () => {
    const res = await listGET(jsonReq('http://localhost/api/cortex/conversations', 'GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data.conversations)).toBe(true);
    expect(body.data.conversations[0].conversationId).toBe(CONV);
    expect(body.data).toHaveProperty('nextPageToken');
    expect(body.data).toHaveProperty('next_page_token');
  });

  it('returns empty list when caller has zero accessible sites', async () => {
    mockGetUserSiteIds.mockResolvedValueOnce([]);
    mockOwnedSitesGet.mockResolvedValueOnce({ docs: [] });
    const res = await listGET(jsonReq('http://localhost/api/cortex/conversations', 'GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.conversations).toEqual([]);
    expect(mockListConversations).not.toHaveBeenCalled();
  });

  it('respects api-key chat scope intersection', async () => {
    mockResolveAuth.mockResolvedValueOnce({
      userId: 'user-1',
      keyContext: {
        keyId: 'k1',
        scopes: [{ resource: 'chat', id: SITE, permissions: ['read'] }],
        environment: 'live',
        expiresAt: Date.now() + 60_000,
        isLegacy: false,
      },
    });
    mockGetUserSiteIds.mockResolvedValueOnce([SITE, 'other-site']);
    await listGET(jsonReq('http://localhost/api/cortex/conversations', 'GET'));
    const passed = mockListConversations.mock.calls[0][0];
    expect(passed.siteIds.sort()).toEqual([SITE]);
  });

  it('filters by explicit siteId when provided', async () => {
    mockGetUserSiteIds.mockResolvedValueOnce([SITE, 'other-site']);
    await listGET(jsonReq(`http://localhost/api/cortex/conversations?siteId=${SITE}`, 'GET'));
    const passed = mockListConversations.mock.calls[0][0];
    expect(passed.siteIds).toEqual([SITE]);
  });

  it('returns an empty page for a siteId outside readable scope', async () => {
    mockGetUserSiteIds.mockResolvedValueOnce([SITE]);
    const res = await listGET(
      jsonReq('http://localhost/api/cortex/conversations?siteId=other-site', 'GET'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.conversations).toEqual([]);
    expect(mockListConversations).not.toHaveBeenCalled();
  });

  it('honors owner=me filter', async () => {
    await listGET(jsonReq('http://localhost/api/cortex/conversations?owner=me', 'GET'));
    const passed = mockListConversations.mock.calls[0][0];
    expect(passed.ownerUid).toBe('user-1');
  });

  it('emits no audit on read', async () => {
    await listGET(jsonReq('http://localhost/api/cortex/conversations', 'GET'));
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });
});

/* ========================================================================== */
/*  POST /api/cortex/conversations - create                                   */
/* ========================================================================== */

describe('POST /api/cortex/conversations', () => {
  it('201 with full conversation payload', async () => {
    const res = await newPOST(
      jsonReq(
        'http://localhost/api/cortex/conversations',
        'POST',
        { siteId: SITE, title: 'first one' },
        { 'idempotency-key': 'k1' },
      ),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.conversationId).toBe(CONV);
    expect(body.data.title).toBe('first one');
  });

  it('400 when siteId is missing', async () => {
    const res = await newPOST(
      jsonReq('http://localhost/api/cortex/conversations', 'POST', {}, { 'idempotency-key': 'k' }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when initial_message has invalid role', async () => {
    const res = await newPOST(
      jsonReq(
        'http://localhost/api/cortex/conversations',
        'POST',
        { siteId: SITE, initial_message: { role: 'invalid', content: 'x' } },
        { 'idempotency-key': 'k' },
      ),
    );
    expect(res.status).toBe(400);
  });

  it('400 when initial_message uses assistant or system role', async () => {
    const res = await newPOST(
      jsonReq(
        'http://localhost/api/cortex/conversations',
        'POST',
        { siteId: SITE, initial_message: { role: 'system', content: 'x' } },
        { 'idempotency-key': 'k' },
      ),
    );
    expect(res.status).toBe(400);
  });

  it('403 when scope insufficient', async () => {
    authForbidden();
    const res = await newPOST(
      jsonReq(
        'http://localhost/api/cortex/conversations',
        'POST',
        { siteId: SITE },
        { 'idempotency-key': 'k' },
      ),
    );
    expect(res.status).toBe(403);
  });

  it('emits chat_mutated audit on create', async () => {
    await newPOST(
      jsonReq(
        'http://localhost/api/cortex/conversations',
        'POST',
        { siteId: SITE },
        { 'idempotency-key': 'k' },
      ),
    );
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'chat_mutated',
        targetId: CONV,
        attributes: expect.objectContaining({
          verb: 'create',
          endpoint: '/api/cortex/conversations',
          method: 'POST',
          siteId: SITE,
        }),
      }),
    );
  });

  it('replays cached idempotency response', async () => {
    mockWithIdempotency.mockImplementationOnce(async () => {
      const { NextResponse } = await import('next/server');
      const r = NextResponse.json({ ok: true, data: { conversationId: 'cached' } }, { status: 201 });
      r.headers.set('Idempotent-Replayed', 'true');
      return r;
    });
    const res = await newPOST(
      jsonReq(
        'http://localhost/api/cortex/conversations',
        'POST',
        { siteId: SITE },
        { 'idempotency-key': 'k' },
      ),
    );
    expect(res.headers.get('Idempotent-Replayed')).toBe('true');
  });
});

/* ========================================================================== */
/*  POST /api/cortex/conversations/{conversationId} - send + stream           */
/* ========================================================================== */

describe('POST /api/cortex/conversations/{conversationId}', () => {
  it('streams an SSE-style text/plain response on happy path', async () => {
    const res = await sendPOST(
      jsonReq(
        `http://localhost/api/cortex/conversations/${CONV}`,
        'POST',
        { role: 'user', content: 'hello' },
        { 'idempotency-key': 'sk1' },
      ),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/text\/plain/);
    expect(res.headers.get('X-Vercel-AI-Data-Stream')).toBe('v1');

    // Read at least one chunk to confirm the stream emits text deltas.
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const decoded = new TextDecoder().decode(value);
    expect(decoded).toContain('0:');
  });

  it('400 when role is invalid', async () => {
    const res = await sendPOST(
      jsonReq(
        `http://localhost/api/cortex/conversations/${CONV}`,
        'POST',
        { role: 'bogus', content: 'x' },
        { 'idempotency-key': 'sk2' },
      ),
      ctx(),
    );
    expect(res.status).toBe(400);
  });

  it('400 when role is assistant or system', async () => {
    const res = await sendPOST(
      jsonReq(
        `http://localhost/api/cortex/conversations/${CONV}`,
        'POST',
        { role: 'assistant', content: 'x' },
        { 'idempotency-key': 'sk2b' },
      ),
      ctx(),
    );
    expect(res.status).toBe(400);
  });

  it('400 when content is missing', async () => {
    const res = await sendPOST(
      jsonReq(
        `http://localhost/api/cortex/conversations/${CONV}`,
        'POST',
        { role: 'user' },
        { 'idempotency-key': 'sk3' },
      ),
      ctx(),
    );
    expect(res.status).toBe(400);
  });

  it('400 when machine override is supplied', async () => {
    const res = await sendPOST(
      jsonReq(
        `http://localhost/api/cortex/conversations/${CONV}`,
        'POST',
        { role: 'user', content: 'x', machineId: 'other-machine' },
        { 'idempotency-key': 'sk3b' },
      ),
      ctx(),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('forbidden_field');
  });

  it('404 when conversation does not exist', async () => {
    mockGetConversation.mockResolvedValueOnce(null);
    const res = await sendPOST(
      jsonReq(
        `http://localhost/api/cortex/conversations/${CONV}`,
        'POST',
        { role: 'user', content: 'x' },
        { 'idempotency-key': 'sk4' },
      ),
      ctx(),
    );
    expect(res.status).toBe(404);
  });

  it('404 when conversation is soft-deleted', async () => {
    mockGetConversation.mockResolvedValueOnce(
      mockConversation({ deletedAt: Timestamp.now() }),
    );
    const res = await sendPOST(
      jsonReq(
        `http://localhost/api/cortex/conversations/${CONV}`,
        'POST',
        { role: 'user', content: 'x' },
        { 'idempotency-key': 'sk5' },
      ),
      ctx(),
    );
    expect(res.status).toBe(404);
  });

  it('403 when scope insufficient', async () => {
    authForbidden();
    const res = await sendPOST(
      jsonReq(
        `http://localhost/api/cortex/conversations/${CONV}`,
        'POST',
        { role: 'user', content: 'x' },
        { 'idempotency-key': 'sk6' },
      ),
      ctx(),
    );
    expect(res.status).toBe(403);
  });

  it('404 when caller is not the conversation owner (cross-user hijack)', async () => {
    // Conversation owned by someone else on the same site. The caller has
    // valid `chat=<siteId>:write` scope on the site (default mock auth) but
    // must not be able to read/write another user's conversation.
    mockGetConversation.mockResolvedValueOnce(
      mockConversation({ ownerUid: 'other-user' }),
    );
    const res = await sendPOST(
      jsonReq(
        `http://localhost/api/cortex/conversations/${CONV}`,
        'POST',
        { role: 'user', content: 'x' },
        { 'idempotency-key': 'sk-hijack' },
      ),
      ctx(),
    );
    // 404 (not 403) intentionally — don't leak existence of another user's chat.
    expect(res.status).toBe(404);
    expect(mockAppendMessage).not.toHaveBeenCalled();
    expect(mockRunCortexStream).not.toHaveBeenCalled();
  });

  it('200 when caller is superadmin overriding owner check', async () => {
    mockUserDocGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ role: 'superadmin' }),
    });
    mockGetConversation.mockResolvedValueOnce(
      mockConversation({ ownerUid: 'other-user' }),
    );
    const res = await sendPOST(
      jsonReq(
        `http://localhost/api/cortex/conversations/${CONV}`,
        'POST',
        { role: 'user', content: 'x' },
        { 'idempotency-key': 'sk-super' },
      ),
      ctx(),
    );
    expect(res.status).toBe(200);
  });

  it('503 when cortex stream reports machine offline', async () => {
    mockRunCortexStream.mockResolvedValueOnce({
      ok: false,
      status: 503,
      error: 'machine offline',
    });
    const res = await sendPOST(
      jsonReq(
        `http://localhost/api/cortex/conversations/${CONV}`,
        'POST',
        { role: 'user', content: 'x' },
        { 'idempotency-key': 'sk7' },
      ),
      ctx(),
    );
    expect(res.status).toBe(503);
  });

  it('persists the user message and emits audit on send', async () => {
    await sendPOST(
      jsonReq(
        `http://localhost/api/cortex/conversations/${CONV}`,
        'POST',
        { role: 'user', content: 'persistent' },
        { 'idempotency-key': 'sk8' },
      ),
      ctx(),
    );
    expect(mockAppendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: CONV,
        role: 'user',
        content: 'persistent',
      }),
    );
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'chat_mutated',
        targetId: CONV,
        attributes: expect.objectContaining({
          verb: 'send',
          endpoint: `/api/cortex/conversations/${CONV}`,
        }),
      }),
    );
  });

  it('caps API-key callers to tier-1 Cortex tools', async () => {
    mockRequireChatAuth.mockResolvedValueOnce({
      ok: true,
      userId: 'user-1',
      auth: {
        userId: 'user-1',
        keyContext: { keyId: 'k1', environment: 'live' },
      },
      scopeCheck: { isLegacy: false },
    });
    await sendPOST(
      jsonReq(
        `http://localhost/api/cortex/conversations/${CONV}`,
        'POST',
        { role: 'user', content: 'x' },
        { 'idempotency-key': 'sk9' },
      ),
      ctx(),
    );
    expect(mockRunCortexStream).toHaveBeenCalledWith(
      expect.objectContaining({ maxToolTier: 1 }),
    );
  });
});

/* ========================================================================== */
/*  PATCH /api/cortex/conversations/{conversationId} - rename                 */
/* ========================================================================== */

describe('PATCH /api/cortex/conversations/{conversationId}', () => {
  it('200 on title-only update', async () => {
    const res = await renamePATCH(
      jsonReq(
        `http://localhost/api/cortex/conversations/${CONV}`,
        'PATCH',
        { title: 'renamed' },
        { 'idempotency-key': 'pk1' },
      ),
      ctx(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.title).toBe('renamed');
  });

  it('400 forbidden_field when other fields supplied', async () => {
    const res = await renamePATCH(
      jsonReq(
        `http://localhost/api/cortex/conversations/${CONV}`,
        'PATCH',
        { title: 'ok', siteId: 'evil' },
        { 'idempotency-key': 'pk2' },
      ),
      ctx(),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('forbidden_field');
  });

  it('400 when title missing', async () => {
    const res = await renamePATCH(
      jsonReq(
        `http://localhost/api/cortex/conversations/${CONV}`,
        'PATCH',
        {},
        { 'idempotency-key': 'pk3' },
      ),
      ctx(),
    );
    expect(res.status).toBe(400);
  });

  it('404 when conversation missing', async () => {
    mockGetConversation.mockResolvedValueOnce(null);
    const res = await renamePATCH(
      jsonReq(
        `http://localhost/api/cortex/conversations/${CONV}`,
        'PATCH',
        { title: 'x' },
        { 'idempotency-key': 'pk4' },
      ),
      ctx(),
    );
    expect(res.status).toBe(404);
  });

  it('emits chat_mutated audit on rename', async () => {
    await renamePATCH(
      jsonReq(
        `http://localhost/api/cortex/conversations/${CONV}`,
        'PATCH',
        { title: 'newer' },
        { 'idempotency-key': 'pk5' },
      ),
      ctx(),
    );
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'chat_mutated',
        attributes: expect.objectContaining({
          verb: 'rename',
          endpoint: `/api/cortex/conversations/${CONV}`,
          newTitle: 'newer',
        }),
      }),
    );
  });
});

/* ========================================================================== */
/*  DELETE /api/cortex/conversations/{conversationId} - soft delete           */
/* ========================================================================== */

describe('DELETE /api/cortex/conversations/{conversationId}', () => {
  it('200 with alreadyDeleted=false on first delete', async () => {
    const res = await deleteDELETE(
      jsonReq(`http://localhost/api/cortex/conversations/${CONV}`, 'DELETE'),
      ctx(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.alreadyDeleted).toBe(false);
  });

  it('200 with alreadyDeleted=true on second delete (true-idempotent)', async () => {
    mockSoftDelete.mockResolvedValueOnce({
      alreadyDeleted: true,
      deletedAt: Timestamp.now(),
    });
    const res = await deleteDELETE(
      jsonReq(`http://localhost/api/cortex/conversations/${CONV}`, 'DELETE'),
      ctx(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.alreadyDeleted).toBe(true);
  });

  it('404 when conversation never existed', async () => {
    mockGetConversation.mockResolvedValueOnce(null);
    const res = await deleteDELETE(
      jsonReq(`http://localhost/api/cortex/conversations/${CONV}`, 'DELETE'),
      ctx(),
    );
    expect(res.status).toBe(404);
  });

  it('403 when scope insufficient', async () => {
    authForbidden();
    const res = await deleteDELETE(
      jsonReq(`http://localhost/api/cortex/conversations/${CONV}`, 'DELETE'),
      ctx(),
    );
    expect(res.status).toBe(403);
  });

  it('401 when caller is unauthorized', async () => {
    authUnauthorized();
    const res = await deleteDELETE(
      jsonReq(`http://localhost/api/cortex/conversations/${CONV}`, 'DELETE'),
      ctx(),
    );
    expect(res.status).toBe(401);
  });

  it('emits chat_mutated audit on delete', async () => {
    await deleteDELETE(
      jsonReq(`http://localhost/api/cortex/conversations/${CONV}`, 'DELETE'),
      ctx(),
    );
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'chat_mutated',
        targetId: CONV,
        attributes: expect.objectContaining({
          verb: 'delete',
          endpoint: `/api/cortex/conversations/${CONV}`,
          method: 'DELETE',
          alreadyDeleted: false,
        }),
      }),
    );
  });
});
