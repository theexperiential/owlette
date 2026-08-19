/**
 * POST /api/hoot/stop — stop a running hoot turn (hoot-async-turns).
 *
 * Body: `{ chatId, turnId }` — the chat and the specific turn to stop (from
 * the chat's `stream/current`).
 *
 * Authorization (in order):
 *   1. `resolveAuth` — session, ID token, or scoped API key (401 otherwise).
 *   2. Chat must exist (404 otherwise) — its `siteId` scopes the access check.
 *   3. `verifyUserSiteAccess` — caller must have access to the chat's site.
 *   4. Chat ownership — the chat must belong to the caller (owner-only; 403).
 *
 * Effect: `finishTurn(db, chatId, turnId, 'cancelled')`. This is turnId- AND
 * status-guarded, so a stale/mismatched turnId or an already-terminal turn
 * no-ops. Marking the stream doc `cancelled` is picked up by the running
 * turn's next heartbeat `touch` (it reports loss of ownership), which aborts
 * the model loop and any in-flight tool poll on the server side.
 *
 * Response: always 200 `{ stopped: true }` — the caller does not need to know
 * whether a live turn was actually running (the effect is idempotent).
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

    // Site access gate — throws on no access.
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
