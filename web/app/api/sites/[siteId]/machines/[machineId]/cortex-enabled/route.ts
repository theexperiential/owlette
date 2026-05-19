/**
 * PATCH /api/sites/{siteId}/machines/{machineId}/cortex-enabled
 *
 * Toggle the per-machine `cortexEnabled` flag. When `false`, cortex tool
 * calls (manual chat + autonomous investigations) are blocked at the
 * dispatch layer for that machine. The agent stays online for monitoring.
 *
 * security-boundary-migration wave 3.2: capability `MACHINE_CONFIG_WRITE`,
 * api-key scope `machine=<id>:write`.
 *
 * Request body:
 *   { "enabled": boolean }
 */
import { NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { resolveAuth } from '@/lib/apiAuth.server';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import { setCortexEnabled } from '@/lib/actions/setCortexEnabled.server';
import { ActionInputError } from '@/lib/actions/createProcess.server';

const patchWrapped = authorizedSiteHandler<{ siteId: string; machineId: string }>({
  capability: 'MACHINE_CONFIG_WRITE',
  siteIdParam: 'path',
  targetKind: 'machine',
  targetIdParam: 'machineId',
  apiKeyScope: { resource: 'machine', idParam: 'machineId', permission: 'write' },
})(async (request, ctx, routeContext) => {
  try {
    const { machineId } = await routeContext.params;

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return problem(400, 'invalid_body', 'Request body must be valid JSON.');
    }

    if (typeof body.enabled !== 'boolean') {
      return problem(400, 'invalid_enabled', 'Field `enabled` must be a boolean.');
    }

    const auth = await resolveAuth(request);
    const auditActor = auth.keyContext
      ? `apiKey:${auth.keyContext.keyId}`
      : `user:${auth.userId}`;

    try {
      const result = await setCortexEnabled(
        { siteId: ctx.siteId, actor: ctx.actor, auditActor },
        { machineId, enabled: body.enabled },
      );
      return NextResponse.json({ ok: true, data: result });
    } catch (e) {
      if (e instanceof ActionInputError) {
        return problem(e.status, e.code, e.message);
      }
      throw e;
    }
  } catch (error: unknown) {
    console.error('sites/machines/cortex-enabled PATCH:', error);
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
