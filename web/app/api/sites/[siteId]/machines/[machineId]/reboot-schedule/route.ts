/**
 * PUT /api/sites/{siteId}/machines/{machineId}/reboot-schedule
 *
 * Set the reboot schedule on a machine's config doc. The agent's existing
 * config listener picks up the new schedule and propagates it to local
 * `config.json`, where the reboot state machine reads it.
 *
 * security-boundary-migration wave 3.2: capability `MACHINE_CONFIG_WRITE`,
 * api-key scope `machine=<id>:write`.
 *
 * Request body:
 *   {
 *     "schedule": {
 *       "enabled": true,
 *       "entries": [
 *         { "id": "uuid", "days": ["mon","tue"], "time": "03:00" }
 *       ]
 *     }
 *   }
 */
import { NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { resolveAuth } from '@/lib/apiAuth.server';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import {
  setRestartSchedule,
  type RestartScheduleInput,
} from '@/lib/actions/setRestartSchedule.server';
import { ActionInputError } from '@/lib/actions/createProcess.server';

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

    if (!body.schedule || typeof body.schedule !== 'object') {
      return problem(400, 'missing_schedule', 'Field `schedule` is required.');
    }

    const auth = await resolveAuth(request);
    const auditActor = auth.keyContext
      ? `apiKey:${auth.keyContext.keyId}`
      : `user:${auth.userId}`;

    try {
      const result = await setRestartSchedule(
        { siteId: ctx.siteId, actor: ctx.actor, auditActor },
        {
          machineId,
          schedule: body.schedule as RestartScheduleInput,
        },
      );
      return NextResponse.json({ ok: true, data: result });
    } catch (e) {
      if (e instanceof ActionInputError) {
        return problem(e.status, e.code, e.message);
      }
      throw e;
    }
  } catch (error: unknown) {
    console.error('sites/machines/reboot-schedule PUT:', error);
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

function problem(status: number, code: string, detail: string): NextResponse {
  return NextResponse.json(
    { type: 'about:blank', title: code, status, code, detail },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}
