/**
 * Display Layout API — PUT (capture / set-auto-restore / reset-breaker) +
 * DELETE (clear).
 *
 * `PUT    /api/sites/{siteId}/machines/{machineId}/display-layout`
 * `DELETE /api/sites/{siteId}/machines/{machineId}/display-layout`
 *
 * security-boundary-migration wave 3.2: capability `MACHINE_CONFIG_WRITE`,
 * api-key scope `machine=<id>:write`.
 *
 * PUT body is discriminated by `op`:
 *
 *   { "op": "capture", "monitors": [...], "capturedBy": "alice@acme.com" }
 *   { "op": "set_auto_restore", "enabled": true,  "enabledBy": "alice@acme.com" }
 *   { "op": "set_auto_restore", "enabled": false }
 *   { "op": "reset_breaker" }
 *
 * DELETE clears the assigned layout entirely. Sibling fields under
 * `displays` (auto-restore state, etc.) survive.
 */
import { NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { resolveAuth } from '@/lib/apiAuth.server';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import {
  setDisplayLayout,
  type SetDisplayLayoutInput,
} from '@/lib/actions/setDisplayLayout.server';
import { clearDisplayLayout } from '@/lib/actions/clearDisplayLayout.server';
import { ActionInputError } from '@/lib/actions/createProcess.server';

/* -------------------------------------------------------------------------- */
/*  PUT — capture / set-auto-restore / reset-breaker                          */
/* -------------------------------------------------------------------------- */

const putWrapped = authorizedSiteHandler<{ siteId: string; machineId: string }>({
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

    const auth = await resolveAuth(request);
    const auditActor = auth.keyContext
      ? `apiKey:${auth.keyContext.keyId}`
      : `user:${auth.userId}`;

    const op = body.op;
    let input: SetDisplayLayoutInput;

    if (op === 'capture') {
      input = {
        machineId,
        op: 'capture',
        monitors: Array.isArray(body.monitors)
          ? (body.monitors as Record<string, unknown>[])
          : [],
        capturedBy: typeof body.capturedBy === 'string' ? body.capturedBy : '',
      };
    } else if (op === 'set_auto_restore') {
      input = {
        machineId,
        op: 'set_auto_restore',
        enabled: typeof body.enabled === 'boolean' ? body.enabled : false,
        ...(typeof body.enabledBy === 'string' ? { enabledBy: body.enabledBy } : {}),
      };
    } else if (op === 'reset_breaker') {
      input = { machineId, op: 'reset_breaker' };
    } else if (op === 'set_remote_apply') {
      input = {
        machineId,
        op: 'set_remote_apply',
        enabled: typeof body.enabled === 'boolean' ? body.enabled : false,
      };
    } else {
      return problem(
        400,
        'invalid_op',
        '`op` must be one of: capture, set_auto_restore, reset_breaker, set_remote_apply.',
      );
    }

    try {
      const result = await setDisplayLayout(
        { siteId: ctx.siteId, actor: ctx.actor, auditActor },
        input,
      );
      return NextResponse.json({ ok: true, data: result });
    } catch (e) {
      if (e instanceof ActionInputError) {
        return problem(e.status, e.code, e.message);
      }
      throw e;
    }
  } catch (error: unknown) {
    console.error('sites/machines/display-layout PUT:', error);
    return problem(
      500,
      'internal_error',
      error instanceof Error ? error.message : 'Internal server error',
    );
  }
});

export const PUT = withRateLimit(putWrapped, {
  strategy: 'api',
  identifier: 'ip',
});

/* -------------------------------------------------------------------------- */
/*  DELETE — clear assigned layout                                            */
/* -------------------------------------------------------------------------- */

const deleteWrapped = authorizedSiteHandler<{ siteId: string; machineId: string }>({
  capability: 'MACHINE_CONFIG_WRITE',
  siteIdParam: 'path',
  targetKind: 'machine',
  targetIdParam: 'machineId',
  apiKeyScope: { resource: 'machine', idParam: 'machineId', permission: 'write' },
})(async (request, ctx, routeContext) => {
  try {
    const { machineId } = await routeContext.params;

    const auth = await resolveAuth(request);
    const auditActor = auth.keyContext
      ? `apiKey:${auth.keyContext.keyId}`
      : `user:${auth.userId}`;

    const result = await clearDisplayLayout(
      { siteId: ctx.siteId, actor: ctx.actor, auditActor },
      { machineId },
    );
    return NextResponse.json({ ok: true, data: result });
  } catch (error: unknown) {
    if (error instanceof ActionInputError) {
      return problem(error.status, error.code, error.message);
    }
    console.error('sites/machines/display-layout DELETE:', error);
    return problem(
      500,
      'internal_error',
      error instanceof Error ? error.message : 'Internal server error',
    );
  }
});

export const DELETE = withRateLimit(deleteWrapped, {
  strategy: 'api',
  identifier: 'ip',
});

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function problem(status: number, code: string, detail: string): NextResponse {
  return NextResponse.json(
    { type: 'about:blank', title: code, status, code, detail },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}
