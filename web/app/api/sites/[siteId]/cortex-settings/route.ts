/**
 * PATCH /api/sites/{siteId}/cortex-settings
 *
 * Update per-site Cortex policy. Currently exposes a single field,
 * `requireTier3Approval`: when `true` (the default), privileged tier-3 tool
 * calls pause for explicit in-chat approval and single-machine admin chats are
 * routed server-side so the approval gate can fire. When `false`, local Cortex
 * is allowed and the gate does not apply.
 *
 * Gated by `MACHINE_CONFIG_WRITE` — the same site-scoped capability that backs
 * the per-machine cortex-enabled toggle, so site admins manage their own site's
 * Cortex policy. Writes go to `sites/{siteId}/settings/cortex` (service-account
 * only at the Firestore-rules layer; clients read it directly).
 *
 * Request body:
 *   { "requireTier3Approval": boolean }
 */
import { NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { resolveAuth } from '@/lib/apiAuth.server';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import { setCortexRequireTier3Approval } from '@/lib/actions/setCortexRequireTier3Approval.server';
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
      const result = await setCortexRequireTier3Approval(
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
    console.error('sites/cortex-settings PATCH:', error);
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
