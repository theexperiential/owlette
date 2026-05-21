/**
 * Canonical public Cortex conversation collection.
 *
 *   GET  /api/cortex/conversations  — list conversations the caller can access
 *   POST /api/cortex/conversations  — create a conversation
 *
 * This is the sole implementation; the legacy `/api/chat` + `/api/chat/new`
 * compatibility aliases were removed (no public consumers existed).
 *
 * GET filters to conversations whose `siteId` is in the caller's effective
 * access set. For api-key callers, the access set is also intersected with the
 * `chat=<siteId>:read` (or wildcard) scopes the key carries — a key scoped to
 * one site cannot list conversations on others, even if the user behind the
 * key has access. Session/id-token callers fall through to the canonical
 * site-membership read (`getUserSiteIds`).
 *
 * POST requires `chat=<siteId>:write`. Idempotent via `Idempotency-Key`.
 * Body: { siteId, machineId?, title?, initial_message?: { role, content } }.
 * machineId is optional: omit for site-wide conversations (server-side LLM
 * fans tools out across all online machines on the site). When provided, the
 * conversation is pinned to that machine — the send endpoint will route to the
 * same machine on every turn.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problemFromError,
  problemUnauthorized,
  problemValidation,
} from '@/lib/apiErrors';
import { ApiAuthError, resolveAuth } from '@/lib/apiAuth.server';
import { getUserSiteIds } from '@/lib/apiHelpers.server';
import { withIdempotency } from '@/lib/idempotency';
import { emitMutation } from '@/lib/auditLogClient';
import { requireChatAuthAndScope, readAndParseJsonBody } from '@/app/api/_shared';
import {
  listConversations,
  createConversation,
  serializeConversationSummary,
  serializeConversation,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type ChatRole,
} from '@/lib/chatStorage.server';
import { getAdminDb } from '@/lib/firebase-admin';

const SITE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const VALID_ROLES: ChatRole[] = ['user'];

/* -------------------------------------------------------------------------- */
/*  GET — list conversations                                                  */
/* -------------------------------------------------------------------------- */

export async function GET(request: NextRequest) {
  try {
    let auth;
    try {
      auth = await resolveAuth(request);
    } catch (err) {
      if (err instanceof ApiAuthError) return problemUnauthorized();
      throw err;
    }

    const pageSizeRaw = Number(
      request.nextUrl.searchParams.get('page_size') ??
        request.nextUrl.searchParams.get('limit') ??
        DEFAULT_PAGE_SIZE,
    );
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(
        1,
        Number.isFinite(pageSizeRaw) ? Math.floor(pageSizeRaw) : DEFAULT_PAGE_SIZE,
      ),
    );
    const pageToken =
      request.nextUrl.searchParams.get('page_token') ??
      request.nextUrl.searchParams.get('cursor') ??
      '';
    const includeDeleted = request.nextUrl.searchParams.get('includeDeleted') === 'true';
    // Conversations are user-private. Default to "owner is me"; only superadmins
    // may opt into a cross-user view via `?owner=all`. Without this default, any
    // site member could enumerate other users' chats on shared sites.
    const ownerParam = request.nextUrl.searchParams.get('owner');
    let ownerFilter: string | undefined = auth.userId;
    if (ownerParam === 'all') {
      const userDoc = await getAdminDb().collection('users').doc(auth.userId).get();
      const isSuperadmin = userDoc.exists && userDoc.data()?.role === 'superadmin';
      if (isSuperadmin) ownerFilter = undefined;
    }
    const siteIdRaw = request.nextUrl.searchParams.get('siteId');

    let requestedSiteId: string | undefined;
    if (siteIdRaw !== null) {
      requestedSiteId = siteIdRaw.trim();
      if (!SITE_ID_RE.test(requestedSiteId)) {
        return problemValidation('invalid siteId format', {
          'query.siteId': ['must be 1-128 chars: letters, digits, underscore, hyphen'],
        });
      }
    }

    const accessibleSiteIds = await resolveReadableSiteIds(auth.userId, auth.keyContext);
    const effectiveSiteIds = requestedSiteId
      ? accessibleSiteIds.filter((siteId) => siteId === requestedSiteId)
      : accessibleSiteIds;

    if (effectiveSiteIds.length === 0) {
      return NextResponse.json({
        ok: true,
        data: { conversations: [], next_page_token: '', nextPageToken: '' },
      });
    }

    const result = await listConversations({
      siteIds: effectiveSiteIds,
      ownerUid: ownerFilter,
      pageSize,
      pageToken,
      includeDeleted,
    });

    return NextResponse.json({
      ok: true,
      data: {
        conversations: result.conversations.map(serializeConversationSummary),
        next_page_token: result.nextPageToken,
        nextPageToken: result.nextPageToken,
      },
    });
  } catch (err) {
    return problemFromError(err, 'cortex/conversations:GET');
  }
}

/**
 * Resolve the set of site ids whose chat conversations the caller may read.
 *
 * - Session/id-token callers: their site-membership list (`getUserSiteIds`),
 *   plus any sites they own (resolved via a `where('owner','==',uid)` read on
 *   the `sites` collection). Superadmins fall back to "every site referenced
 *   by their key/membership" — we deliberately do not return a wildcard set
 *   here because the underlying list helper enforces a site-id filter to keep
 *   query plans sane.
 * - Api-key callers with scoped keys: intersection of their site-membership
 *   list with the `chat` scopes on the key. A wildcard chat scope (`chat=*`)
 *   widens the intersection back to the full membership list.
 * - Api-key callers with legacy keys (`scopes` empty/absent): treated like
 *   session callers — full membership list, no scope intersection.
 */
async function resolveReadableSiteIds(
  userId: string,
  keyContext: Awaited<ReturnType<typeof resolveAuth>>['keyContext'],
): Promise<string[]> {
  const membership = await getUserSiteIds(userId);
  const ownedSites = await readOwnedSiteIds(userId);
  const membershipSet = new Set<string>([...membership, ...ownedSites]);

  if (!keyContext || keyContext.isLegacy || !keyContext.scopes) {
    return [...membershipSet];
  }

  const chatScopes = keyContext.scopes.filter(
    (s) => s.resource === 'chat' && s.permissions.includes('read'),
  );
  if (chatScopes.length === 0) return [];
  if (chatScopes.some((s) => s.id === '*')) return [...membershipSet];

  const allowed = new Set(chatScopes.map((s) => s.id));
  return [...membershipSet].filter((siteId) => allowed.has(siteId));
}

async function readOwnedSiteIds(userId: string): Promise<string[]> {
  try {
    const db = getAdminDb();
    const snap = await db.collection('sites').where('owner', '==', userId).get();
    return snap.docs.map((d) => d.id);
  } catch {
    // Owner-lookup failures degrade gracefully: the caller still sees their
    // membership list. The list filter is a defence-in-depth narrowing — it
    // never grants access beyond the underlying scope/membership check.
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/*  POST — create a conversation                                              */
/* -------------------------------------------------------------------------- */

interface CreateBody {
  siteId?: unknown;
  machineId?: unknown;
  title?: unknown;
  initial_message?: unknown;
}

export async function POST(request: NextRequest) {
  try {
    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as CreateBody;

    if (typeof body.siteId !== 'string' || body.siteId.trim().length === 0) {
      return problemValidation('field `siteId` is required and must be a non-empty string', {
        'body.siteId': ['required non-empty string'],
      });
    }
    const siteId = body.siteId.trim();

    let machineId: string | undefined;
    if (body.machineId !== undefined && body.machineId !== null) {
      if (typeof body.machineId !== 'string' || body.machineId.length === 0) {
        return problemValidation('machineId must be a non-empty string when provided', {
          'body.machineId': ['must be non-empty string'],
        });
      }
      machineId = body.machineId;
    }

    let initialMessage: { role: ChatRole; content: string } | undefined;
    if (body.initial_message !== undefined && body.initial_message !== null) {
      if (typeof body.initial_message !== 'object') {
        return problemValidation('initial_message must be an object when provided', {
          'body.initial_message': ['must be object'],
        });
      }
      const im = body.initial_message as Record<string, unknown>;
      const role = im.role;
      const content = im.content;
      if (typeof role !== 'string' || !VALID_ROLES.includes(role as ChatRole)) {
        return problemValidation(
          'initial_message.role must be `user` for public Cortex conversations',
          { 'body.initial_message.role': ['invalid role'] },
        );
      }
      if (typeof content !== 'string' || content.length === 0) {
        return problemValidation('initial_message.content must be a non-empty string', {
          'body.initial_message.content': ['required non-empty string'],
        });
      }
      initialMessage = { role: role as ChatRole, content };
    }

    const auth = await requireChatAuthAndScope(request, siteId, 'write');
    if (!auth.ok) return auth.response;

    return withIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        const conversation = await createConversation({
          siteId,
          ownerUid: auth.userId,
          machineId,
          title: typeof body.title === 'string' ? body.title : undefined,
          initialMessages: initialMessage ? [initialMessage] : undefined,
        });

        emitMutation({
          kind: 'chat_mutated',
          siteId,
          actor: auth.auth.keyContext
            ? `apiKey:${auth.auth.keyContext.keyId}`
            : `user:${auth.userId}`,
          targetId: conversation.conversationId,
          attributes: {
            verb: 'create',
            endpoint: request.nextUrl.pathname,
            method: 'POST',
            siteId,
            ...(machineId ? { machineId } : {}),
          },
        });

        return NextResponse.json(
          { ok: true, data: serializeConversation(conversation) },
          { status: 201 },
        );
      },
      { requireKey: true },
    );
  } catch (err) {
    return problemFromError(err, 'cortex/conversations:POST');
  }
}
