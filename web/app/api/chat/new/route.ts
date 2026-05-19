/**
 * POST /api/cortex/conversations — create a Cortex conversation.
 *
 * `/api/chat/new` remains a compatibility alias; `/api/cortex/conversations`
 * is the canonical public API path as of public-api Wave 2.9.
 *
 * Required scope: `chat=<siteId>:write`. Idempotent via `Idempotency-Key`.
 * Body:
 *   { siteId, machineId?, title?, initial_message?: { role, content } }
 *
 * machineId is optional: omit for site-wide conversations (server-side LLM
 * fans tools out across all online machines on the site). When provided,
 * the conversation is pinned to that machine — the send endpoint will
 * route to the same machine on every turn.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problemFromError,
  problemValidation,
} from '@/lib/apiErrors';
import { withIdempotency } from '@/lib/idempotency';
import { emitMutation } from '@/lib/auditLogClient';
import { requireChatAuthAndScope, readAndParseJsonBody } from '@/app/api/_shared';
import {
  createConversation,
  serializeConversation,
  type ChatRole,
} from '@/lib/chatStorage.server';

const VALID_ROLES: ChatRole[] = ['user'];

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
    return problemFromError(err, 'chat/new:POST');
  }
}
