/**
 * Core chat API endpoint — async turn architecture (hoot-async-turns).
 *
 * POST authenticates, verifies site access, acquires the per-chat turn lock
 * (`chats/{chatId}/stream/current`), and starts a detached turn runner. The
 * runner owns the LLM loop + tool relay and persists progress to Firestore,
 * so the turn survives a dead HTTP stream; the stream returned here is a
 * best-effort live branch of the same turn (clients reattach via Firestore).
 */

import { NextRequest, NextResponse } from 'next/server';
import { createUIMessageStreamResponse, type UIMessage } from 'ai';
import { resolveAuth, requireScope } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';
import {
  verifyUserSiteAccess,
  isMachineOnline,
  isHootEnabled,
  getOnlineMachines,
} from '@/lib/hoot-utils.server';
import { startTurn } from '@/lib/hoot/turnRunner.server';
import {
  acquireTurnLock,
  generateTurnId,
  TurnActiveError,
} from '@/lib/hoot/turnStore.server';

const SITE_TARGET_ID = '__site__';

// Note: Streaming responses are incompatible with withRateLimit's header injection,
// so we handle rate limiting manually if needed in the future.
export async function POST(request: NextRequest) {
  try {
    // Accept session, ID-token, or scoped API key. Session/ID-token callers
    // bypass scope enforcement (dashboard); api-key callers must hold
    // `chat=<siteId>:write` to send a message into a conversation.
    const auth = await resolveAuth(request);
    const userId = auth.userId;
    const body = await request.json();

    const {
      messages,
      siteId,
      machineId,
      machineName,
      chatId,
      supersede,
    } = body as {
      messages: UIMessage[];  // AI SDK UIMessages (text + file + tool/approval parts)
      siteId: string;
      machineId: string;
      machineName: string;
      chatId: string;
      /** Claim the turn lock even while another turn is running (new user message mid-turn). */
      supersede?: boolean;
    };

    if (!messages || !Array.isArray(messages) || messages.length === 0 || !siteId || !chatId) {
      return NextResponse.json(
        { error: 'messages, siteId, and chatId are required' },
        { status: 400 },
      );
    }

    // Scope check is only enforced for API-key callers; session/ID-token
    // auth bypasses (own-site dashboard access is checked below via
    // verifyUserSiteAccess). Throws 403 scope_insufficient on mismatch.
    requireScope(auth, 'chat', siteId, 'write');

    const db = getAdminDb();
    const isSiteMode = machineId === SITE_TARGET_ID;

    // Verify access and resolve tier ceiling. Session/id-token callers use
    // their site role. API-key callers are capped to read-only tools so a
    // chat-scoped key cannot inherit the owner's admin role and dispatch
    // destructive machine/process/deploy tools.
    const access = await verifyUserSiteAccess(db, userId, siteId);
    const effectiveAccess = auth.keyContext
      ? { ...access, isSuperadmin: false, isSiteAdmin: false }
      : access;

    // Chat ownership guard. Site access alone is not enough — a chat belongs to
    // the user who created it. When the chat doc already exists it must match
    // the caller (userId) and target site; a mismatch is a cross-user write
    // attempt (the runner persists via the admin SDK, bypassing Firestore
    // rules, so this is the only gate). A non-existent doc is allowed — the
    // first turn of a new chat legitimately creates it.
    const existingChatSnap = await db.collection('chats').doc(chatId).get();
    if (existingChatSnap.exists) {
      const chatData = existingChatSnap.data();
      if (chatData?.userId !== userId || chatData?.siteId !== siteId) {
        return NextResponse.json({ error: 'you do not own this chat' }, { status: 403 });
      }
    }

    if (isSiteMode) {
      // ─── Site-Wide Mode ────────────────────────────────────────────────
      // User-facing 503 before committing a turn. The runner refetches the
      // online-machine list itself; the double fetch is accepted so an empty
      // site fails here instead of inside an already-locked turn.
      const onlineMachines = await getOnlineMachines(db, siteId);
      if (onlineMachines.length === 0) {
        return NextResponse.json(
          { error: 'No machines are currently online in this site.' },
          { status: 503 },
        );
      }
    } else {
      // ─── Single Machine Mode ───────────────────────────────────────────
      if (!machineId) {
        return NextResponse.json(
          { error: 'machineId is required for single-machine mode' },
          { status: 400 },
        );
      }

      const online = await isMachineOnline(db, siteId, machineId);
      if (!online) {
        return NextResponse.json(
          { error: `Machine "${machineName || machineId}" appears to be offline.` },
          { status: 503 },
        );
      }

      const hootEnabled = await isHootEnabled(db, siteId, machineId);
      if (!hootEnabled) {
        return NextResponse.json(
          { error: `Hoot is disabled on "${machineName || machineId}". Re-enable it from the Hoot header to deliver tool calls.` },
          { status: 423 },
        );
      }
    }

    // acquireTurnLock returns the PRIOR turn's toolCommands recovery index
    // (read inside the same claim transaction), so this turn can splice in real
    // agent results for tool calls whose runner died — no separate pre-lock
    // read (which would be a TOCTOU against the overwrite the claim performs).
    const turnId = generateTurnId();
    let priorToolCommands;
    try {
      priorToolCommands = await acquireTurnLock(db, chatId, {
        turnId,
        siteId,
        machineId,
        supersede: supersede === true,
      });
    } catch (error) {
      if (error instanceof TurnActiveError) {
        return NextResponse.json(
          { error: 'a turn is already running', code: 'turn_active' },
          { status: 409 },
        );
      }
      throw error;
    }

    // Detached runner: returns immediately with the live stream branch; the
    // turn itself keeps running (and persisting to Firestore) even if this
    // HTTP response dies.
    const stream = startTurn(db, {
      chatId,
      turnId,
      siteId,
      machineId,
      machineName: machineName || '',
      messages,
      userId,
      access: effectiveAccess,
      priorToolCommands,
    });

    // Client disconnect: cancel the HTTP tee branch so we don't hold the
    // response open. The turn itself keeps running (the snapshot pump owns the
    // other tee branch), so nothing is lost — the client reattaches via the
    // stream doc.
    request.signal.addEventListener('abort', () => {
      void stream.cancel().catch(() => {});
    });

    return createUIMessageStreamResponse({ stream });
  } catch (error: unknown) {
    return apiError(error, 'hoot');
  }
}
