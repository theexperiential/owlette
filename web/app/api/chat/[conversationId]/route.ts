/**
 * Per-conversation chat-noun routes.
 *
 *   POST   /api/cortex/conversations/{conversationId}  — append a user message + stream
 *   PATCH  /api/cortex/conversations/{conversationId}  — rename (title-only)
 *   DELETE /api/cortex/conversations/{conversationId}  — soft-delete (true-idempotent)
 *
 * `/api/chat/{conversationId}` remains a compatibility alias; the
 * `/api/cortex/conversations/{conversationId}` path is canonical.
 *
 * All three verbs require `chat=<siteId>:write`. siteId is read from the
 * conversation document (the URL only carries the conversation id) and
 * passed into `requireChatAuthAndScope` so api-key callers must hold the
 * correct site-scoped chat permission.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problemFromError,
  problemNotFound,
  problemValidation,
  problem,
  ProblemType,
} from '@/lib/apiErrors';
import { withIdempotency } from '@/lib/idempotency';
import { emitMutation } from '@/lib/auditLogClient';
import { requireChatAuthAndScope, readAndParseJsonBody } from '@/app/api/_shared';
import {
  appendMessage,
  ChatStorageError,
  getConversation,
  renameConversation,
  softDeleteConversation,
  type ChatConversation,
  type ChatRole,
} from '@/lib/chatStorage.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { runCortexStream, SITE_TARGET_ID } from '@/lib/cortexStream.server';
import type { ModelMessage } from 'ai';

interface RouteContext {
  params: Promise<{ conversationId: string }>;
}

const VALID_ROLES: ChatRole[] = ['user'];
const SEND_ALLOWED_FIELDS = new Set(['role', 'content']);

/**
 * Conversations are user-private within a site: only the owner (or a
 * platform superadmin) may read/write/delete them. Without this guard, any
 * site member with `chat=<siteId>:write` could access other users' chats
 * on the same site.
 *
 * Returns 404 (not 403) on miss to avoid leaking the existence of another
 * user's conversation.
 */
async function ensureConversationOwner(
  conversation: ChatConversation,
  userId: string,
): Promise<NextResponse | null> {
  if (conversation.ownerUid === userId) return null;
  const userDoc = await getAdminDb().collection('users').doc(userId).get();
  if (userDoc.exists && userDoc.data()?.role === 'superadmin') return null;
  return problemNotFound('conversation not found');
}

/* -------------------------------------------------------------------------- */
/*  POST — send message + stream response                                     */
/* -------------------------------------------------------------------------- */

interface SendBody {
  role?: unknown;
  content?: unknown;
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { conversationId } = await params;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as SendBody;

    const extraFields = Object.keys(body).filter((k) => !SEND_ALLOWED_FIELDS.has(k));
    if (extraFields.length > 0) {
      return problem({
        type: ProblemType.ValidationFailed,
        title: 'forbidden_field',
        status: 400,
        detail: 'public Cortex send accepts only `role` and `content`',
        code: 'forbidden_field',
        errors: { body: [`unexpected fields: ${extraFields.join(', ')}`] },
      });
    }

    const role = body.role;
    if (typeof role !== 'string' || !VALID_ROLES.includes(role as ChatRole)) {
      return problemValidation(
        'field `role` must be `user` for public Cortex conversations',
        { 'body.role': ['invalid role'] },
      );
    }
    const content = body.content;
    if (typeof content !== 'string' || content.length === 0) {
      return problemValidation('field `content` must be a non-empty string', {
        'body.content': ['required non-empty string'],
      });
    }

    const conversation = await getConversation(conversationId);
    if (!conversation || conversation.deletedAt) {
      return problemNotFound('conversation not found');
    }

    const auth = await requireChatAuthAndScope(request, conversation.siteId, 'write');
    if (!auth.ok) return auth.response;

    const ownerCheck = await ensureConversationOwner(conversation, auth.userId);
    if (ownerCheck) return ownerCheck;

    return withIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        // Persist the user's turn before kicking off the LLM. If the stream
        // fails we still have the prompt on disk for retries.
        try {
          await appendMessage({
            conversationId,
            role: role as ChatRole,
            content,
          });
        } catch (err) {
          if (err instanceof ChatStorageError) {
            return problem({
              type: ProblemType.NotFound,
              title: err.code,
              status: err.status,
              detail: err.message,
              code: err.code,
            });
          }
          throw err;
        }

        // Reload to get the freshly-appended message in the prompt.
        const refreshed = await getConversation(conversationId);
        if (!refreshed) return problemNotFound('conversation not found');

        const machineId = resolveMachineId(refreshed);
        const machineName = machineId === SITE_TARGET_ID ? 'site' : machineId;

        const modelMessages = refreshed.messages.map<ModelMessage>((m) => ({
          role: m.role,
          content: m.content,
        }));

        const streamResult = await runCortexStream({
          db: getAdminDb(),
          userId: auth.userId,
          siteId: refreshed.siteId,
          machineId,
          machineName,
          messages: modelMessages,
          chatId: conversationId,
          maxToolTier: auth.auth.keyContext ? 1 : undefined,
          onAssistantText: async (assistantText) => {
            if (!assistantText.trim()) return;
            try {
              await appendMessage({
                conversationId,
                role: 'assistant',
                content: assistantText,
              });
            } catch (err) {
              console.warn('[chat] failed to persist assistant turn:', err);
            }
          },
        });

        emitMutation({
          kind: 'chat_mutated',
          siteId: refreshed.siteId,
          actor: auth.auth.keyContext
            ? `apiKey:${auth.auth.keyContext.keyId}`
            : `user:${auth.userId}`,
          targetId: conversationId,
          attributes: {
            verb: 'send',
            endpoint: request.nextUrl.pathname,
            method: 'POST',
            siteId: refreshed.siteId,
            machineId,
          },
        });

        if (!streamResult.ok) {
          return problem({
            type: ProblemType.ServiceUnavailable,
            title: 'cortex stream unavailable',
            status: streamResult.status,
            detail: streamResult.error,
            code: 'cortex_unavailable',
          });
        }

        // Pass the streaming response straight through. NOTE: idempotency
        // caching is a no-op for streaming responses (the wrapper only
        // caches NextResponse text bodies); this means a replayed stream
        // will execute again rather than returning a cached transcript.
        // That's intentional — the assistant's reply is non-deterministic
        // and we rely on the user-message append being naturally
        // idempotent at the transport layer (same key, same content =
        // same write).
        return streamResult.response as unknown as NextResponse;
      },
      { requireKey: true },
    );
  } catch (err) {
    return problemFromError(err, `chat/[conversationId]:POST`);
  }
}

/* -------------------------------------------------------------------------- */
/*  PATCH — rename                                                            */
/* -------------------------------------------------------------------------- */

const PATCH_ALLOWED_FIELDS = new Set(['title']);

interface PatchBody {
  title?: unknown;
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const { conversationId } = await params;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as PatchBody;

    const extraFields = Object.keys(body).filter((k) => !PATCH_ALLOWED_FIELDS.has(k));
    if (extraFields.length > 0) {
      return problem({
        type: ProblemType.ValidationFailed,
        title: 'forbidden_field',
        status: 400,
        detail: `only the following fields are mutable: ${[...PATCH_ALLOWED_FIELDS].join(', ')}`,
        code: 'forbidden_field',
        errors: { body: [`unexpected fields: ${extraFields.join(', ')}`] },
      });
    }

    if (body.title === undefined) {
      return problemValidation('field `title` is required for rename', {
        'body.title': ['required'],
      });
    }
    if (typeof body.title !== 'string' || body.title.trim().length === 0) {
      return problemValidation('field `title` must be a non-empty string', {
        'body.title': ['required non-empty string'],
      });
    }

    const conversation = await getConversation(conversationId);
    if (!conversation || conversation.deletedAt) {
      return problemNotFound('conversation not found');
    }

    const auth = await requireChatAuthAndScope(request, conversation.siteId, 'write');
    if (!auth.ok) return auth.response;

    const ownerCheck = await ensureConversationOwner(conversation, auth.userId);
    if (ownerCheck) return ownerCheck;

    return withIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        let renamed: { title: string };
        try {
          renamed = await renameConversation(conversationId, body.title);
        } catch (err) {
          if (err instanceof ChatStorageError) {
            return problem({
              type: ProblemType.NotFound,
              title: err.code,
              status: err.status,
              detail: err.message,
              code: err.code,
            });
          }
          throw err;
        }

        emitMutation({
          kind: 'chat_mutated',
          siteId: conversation.siteId,
          actor: auth.auth.keyContext
            ? `apiKey:${auth.auth.keyContext.keyId}`
            : `user:${auth.userId}`,
          targetId: conversationId,
          attributes: {
            verb: 'rename',
            endpoint: request.nextUrl.pathname,
            method: 'PATCH',
            siteId: conversation.siteId,
            newTitle: renamed.title,
          },
        });

        return NextResponse.json({
          ok: true,
          data: {
            conversationId,
            title: renamed.title,
          },
        });
      },
    );
  } catch (err) {
    return problemFromError(err, 'chat/[conversationId]:PATCH');
  }
}

/* -------------------------------------------------------------------------- */
/*  DELETE — soft delete                                                      */
/* -------------------------------------------------------------------------- */

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  try {
    const { conversationId } = await params;

    const conversation = await getConversation(conversationId);
    if (!conversation) {
      // Hard 404 on never-existed: idempotency would be misleading because
      // the caller is targeting a resource that has no site to authorize on.
      return problemNotFound('conversation not found');
    }

    const auth = await requireChatAuthAndScope(request, conversation.siteId, 'write');
    if (!auth.ok) return auth.response;

    const ownerCheck = await ensureConversationOwner(conversation, auth.userId);
    if (ownerCheck) return ownerCheck;

    return withIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.auth.keyContext?.environment ?? 'unknown',
      },
      // DELETE has no body, but withIdempotency still hashes a key against
      // an empty string — same pattern as the rest of the suite.
      '',
      async () => {
        let result: { alreadyDeleted: boolean };
        try {
          result = await softDeleteConversation(conversationId);
        } catch (err) {
          if (err instanceof ChatStorageError && err.status === 404) {
            // Race: conversation got hard-deleted between the gate read and
            // the txn. Treat as already-deleted for idempotency.
            result = { alreadyDeleted: true };
          } else if (err instanceof ChatStorageError) {
            return problem({
              type: ProblemType.NotFound,
              title: err.code,
              status: err.status,
              detail: err.message,
              code: err.code,
            });
          } else {
            throw err;
          }
        }

        emitMutation({
          kind: 'chat_mutated',
          siteId: conversation.siteId,
          actor: auth.auth.keyContext
            ? `apiKey:${auth.auth.keyContext.keyId}`
            : `user:${auth.userId}`,
          targetId: conversationId,
          attributes: {
            verb: 'delete',
            endpoint: request.nextUrl.pathname,
            method: 'DELETE',
            siteId: conversation.siteId,
            alreadyDeleted: result.alreadyDeleted,
          },
        });

        return NextResponse.json({
          ok: true,
          data: {
            conversationId,
            alreadyDeleted: result.alreadyDeleted,
          },
        });
      },
    );
  } catch (err) {
    return problemFromError(err, 'chat/[conversationId]:DELETE');
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function resolveMachineId(
  conversation: ChatConversation,
): string {
  if (conversation.machineId) return conversation.machineId;
  return SITE_TARGET_ID;
}
