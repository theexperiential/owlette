/**
 * POST /api/hoot/stop — stop a running hoot turn. Body `{ chatId, turnId }`
 * (turnId from the chat's `stream/current`).
 *
 * Auth in order: resolveAuth (401) → chat exists (404, and its siteId scopes
 * the next check) → verifyUserSiteAccess → chat ownership (403, owner-only).
 *
 * Effect is `finishTurn(..., 'cancelled')`, turnId- and status-guarded so a
 * stale turnId or terminal turn no-ops. The running turn's next heartbeat
 * `touch` sees the lost ownership and aborts the model loop and tool poll.
 *
 * Always 200 `{ stopped: true }` — idempotent, so the caller needn't know
 * whether a turn was live.
 */

import { NextRequest, NextResponse } from 'next/server';
import { ApiAuthError, resolveAuth } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';
import { verifyUserSiteAccess } from '@/lib/hoot-utils.server';
import { finishTurn } from '@/lib/hoot/turnStore.server';
import { getUserIdFromSession, withRateLimit } from '@/lib/withRateLimit';

interface StopBody {
  chatId?: unknown;
  turnId?: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

async function handleStop(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await resolveAuth(request);

    const body = (await request.json().catch(() => null)) as StopBody | null;
    const chatId = body?.chatId;
    const turnId = body?.turnId;

    if (!isNonEmptyString(chatId) || !isNonEmptyString(turnId)) {
      return NextResponse.json(
        { error: 'chatId and turnId are required' },
        { status: 400 },
      );
    }

    const db = getAdminDb();

    const chatSnap = await db.collection('chats').doc(chatId).get();
    if (!chatSnap.exists) {
      return NextResponse.json({ error: 'chat not found' }, { status: 404 });
    }
    const chatData = chatSnap.data() ?? {};
    const siteId = chatData.siteId;
    if (!isNonEmptyString(siteId)) {
      return NextResponse.json({ error: 'chat not found' }, { status: 404 });
    }

    // Throws on no access.
    try {
      await verifyUserSiteAccess(db, auth.userId, siteId);
    } catch {
      return NextResponse.json(
        { error: 'you do not have access to this site' },
        { status: 403 },
      );
    }

    // Stops are owner-only: the chat must belong to the caller.
    if (chatData.userId !== auth.userId) {
      return NextResponse.json({ error: 'you do not own this chat' }, { status: 403 });
    }

    // Guarded: a stale turnId or an already-terminal turn no-ops.
    await finishTurn(db, chatId, turnId, 'cancelled');

    return NextResponse.json({ stopped: true });
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json(
        { error: error.message, ...(error.code ? { code: error.code } : {}) },
        { status: error.status },
      );
    }
    return apiError(error, 'hoot/stop');
  }
}

export const POST = withRateLimit(handleStop, {
  strategy: 'user',
  identifier: 'user',
  getUserId: getUserIdFromSession,
});
