/**
 * PATCH /api/sites/{siteId}/hoot-settings — body `{ requireTier3Approval: boolean }`.
 *
 * True (the default) pauses tier-3 tool calls for in-chat approval and routes
 * single-machine admin chats server-side so the gate can fire; false allows
 * local Hoot, where it cannot.
 *
 * Gated by `MACHINE_CONFIG_WRITE`, the same capability as the per-machine
 * hoot-enabled toggle. Writes `sites/{siteId}/settings/cortex` — service-account
 * only in the rules; clients read it directly.
 */
import { NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { resolveAuth } from '@/lib/apiAuth.server';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import { setHootRequireTier3Approval } from '@/lib/actions/setHootRequireTier3Approval.server';
import { ActionInputError } from '@/lib/actions/createProcess.server';

const patchWrapped = authorizedSiteHandler<{ siteId: string }>({
  capability: 'MACHINE_CONFIG_WRITE',
  siteIdParam: 'path',
})(async (request, ctx) => {
  try {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return problem(400, 'invalid_body', 'Request body must be valid JSON.');
    }

    if (typeof body.requireTier3Approval !== 'boolean') {
      return problem(
        400,
        'invalid_require_tier3_approval',
        'Field `requireTier3Approval` must be a boolean.',
      );
    }

    const auth = await resolveAuth(request);
    const auditActor = auth.keyContext
      ? `apiKey:${auth.keyContext.keyId}`
      : `user:${auth.userId}`;

    try {
      const result = await setHootRequireTier3Approval(
        { siteId: ctx.siteId, actor: ctx.actor, auditActor },
        { requireTier3Approval: body.requireTier3Approval },
      );
      return NextResponse.json({ ok: true, data: result });
    } catch (e) {
      if (e instanceof ActionInputError) {
        return problem(e.status, e.code, e.message);
      }
      throw e;
    }
  } catch (error: unknown) {
    console.error('sites/hoot-settings PATCH:', error);
    return problem(
      500,
      'internal_error',
      error instanceof Error ? error.message : 'Internal server error',
    );
  }
});

export const PATCH = withRateLimit(patchWrapped, {
  strategy: 'api',
  identifier: 'ip',
});

function problem(status: number, code: string, detail: string): NextResponse {
  return NextResponse.json(
    { type: 'about:blank', title: code, status, code, detail },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}
