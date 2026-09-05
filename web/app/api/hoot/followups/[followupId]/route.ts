/**
 * DELETE /api/hoot/followups/{followupId} — cancel a scheduled hoot follow-up.
 *
 * The chip above the composer calls this; the model cancels through the
 * `cancel_followup` tool instead, which reaches the same store helper.
 *
 * Authorization, in order: resolveAuth (401) → the follow-up must exist (404,
 * and its `siteId` scopes the next two checks) → requireScope(chat=<siteId>:write),
 * api-key callers only → verifyUserSiteAccess (403) → ownership, enforced inside
 * `cancelFollowup`'s transaction (403). Ownership lives there on purpose: the
 * Admin SDK bypasses firestore.rules, so the store is the only gate that every
 * caller — route and tool alike — passes through.
 *
 * Outcomes map straight from the store: cancelled → 200, not_found → 404,
 * forbidden → 403, not_scheduled → 409 (the sweep already claimed it, or it was
 * cancelled before). Only the 200 changed state, so only the 200 audits
 * (`chat_mutated` / verb `cancel_followup`).
 */

import { NextRequest, NextResponse } from 'next/server';
import { ApiAuthError, resolveAuth, requireScope } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';
import { emitMutation } from '@/lib/auditLogClient';
import { verifyUserSiteAccess } from '@/lib/hoot-utils.server';
import { cancelFollowup, followupsCollection } from '@/lib/hoot/followupStore.server';
import { getUserIdFromSession, withRateLimit } from '@/lib/withRateLimit';

interface RouteContext {
  params: Promise<{ followupId: string }>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

async function handleCancelFollowup(
  request: NextRequest,
  { params }: RouteContext,
): Promise<NextResponse> {
  try {
    const auth = await resolveAuth(request);

    const { followupId } = await params;
    if (!isNonEmptyString(followupId)) {
      return NextResponse.json({ error: 'followupId is required' }, { status: 400 });
    }

    const db = getAdminDb();

    // Read only what the scope/site gate needs — the cancel itself re-reads the
    // doc transactionally, so nothing here is trusted for the decision to write.
    const snap = await followupsCollection(db).doc(followupId).get();
    const followup = snap.data();
    const siteId = followup?.siteId;
    if (!snap.exists || !isNonEmptyString(siteId)) {
      return NextResponse.json({ error: 'follow-up not found' }, { status: 404 });
    }

    // api-key callers only; session/ID-token auth is covered by the site-access check.
    requireScope(auth, 'chat', siteId, 'write');

    try {
      await verifyUserSiteAccess(db, auth.userId, siteId);
    } catch {
      return NextResponse.json(
        { error: 'you do not have access to this site' },
        { status: 403 },
      );
    }

    const outcome = await cancelFollowup(db, followupId, { userId: auth.userId });
    switch (outcome) {
      case 'cancelled':
        // Deliberately no `note`: it is free-form operator text with no audit value.
        emitMutation({
          kind: 'chat_mutated',
          siteId,
          actor: auth.keyContext ? `apiKey:${auth.keyContext.keyId}` : `user:${auth.userId}`,
          targetId: followupId,
          attributes: {
            verb: 'cancel_followup',
            endpoint: request.nextUrl.pathname,
            method: 'DELETE',
            siteId,
            ...(isNonEmptyString(followup?.chatId) ? { chatId: followup.chatId } : {}),
          },
        });
        return NextResponse.json({ cancelled: true });
      case 'not_found':
        return NextResponse.json({ error: 'follow-up not found' }, { status: 404 });
      case 'forbidden':
        return NextResponse.json(
          { error: 'you do not own this follow-up' },
          { status: 403 },
        );
      case 'not_scheduled':
        return NextResponse.json(
          { error: 'follow-up is no longer scheduled' },
          { status: 409 },
        );
    }
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json(
        { error: error.message, ...(error.code ? { code: error.code } : {}) },
        { status: error.status },
      );
    }
    return apiError(error, 'hoot/followups');
  }
}

export const DELETE = withRateLimit(handleCancelFollowup, {
  strategy: 'user',
  identifier: 'user',
  getUserId: getUserIdFromSession,
});
