/**
 * `POST /api/sites/{siteId}/machines/{machineId}/processes/{processId}/schedule`
 *
 * Update the `schedule` field on a process. Does NOT use the command queue —
 * the agent reads the schedule on its next monitoring loop.
 *
 * Body shape (per api-surface):
 *   { mode: 'off' | 'always' | 'scheduled', blocks: ScheduleBlock[]? }
 *
 * `blocks` is required when mode === 'scheduled'.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError } from '@/lib/apiAuth.server';
import { withIdempotency } from '@/lib/idempotency';
import { emitMutation } from '@/lib/auditLogClient';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import {
  withProcessLock,
  findProcessIndex,
  ProcessConfigError,
} from '@/lib/processConfig.server';
import { validateProcessScheduleBody } from '@/lib/processPayloadValidation';
import logger from '@/lib/logger';

interface RouteParams {
  [key: string]: string | undefined;
  siteId: string;
  machineId: string;
  processId: string;
}

interface RouteContext {
  params: Promise<{ siteId: string; machineId: string; processId: string }>;
}

const wrapped = authorizedSiteHandler<RouteParams>({
  capability: 'MACHINE_CONFIG_WRITE',
  siteIdParam: 'path',
  targetKind: 'process',
  targetIdParam: 'processId',
  apiKeyScope: { resource: 'machine', idParam: 'machineId', permission: 'write' },
})(async (request: NextRequest, ctx, context: RouteContext) => {
  try {
    const { machineId, processId } = await context.params;
    const siteId = ctx.siteId;

    const rawBody = await request.text();
    let body: Record<string, unknown>;
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      return problem(400, 'invalid_body', 'Request body must be valid JSON.');
    }

    const validation = validateProcessScheduleBody(body);
    if (!validation.ok) {
      return problem(validation.error.status, validation.error.code, validation.error.detail);
    }
    const { mode, blocks } = validation.value;

    return withIdempotency(
      request,
      {
        userId: ctx.actor.userId,
        environment: ctx.auth.keyContext?.environment ?? 'unknown',
      },
      rawBody,
      async () => {
        try {
          await withProcessLock(siteId, machineId, (processes) => {
            const idx = findProcessIndex(processes, processId);
            if (idx === -1) {
              throw new ProcessConfigError(
                404,
                `Process ${processId} not found`,
                'process_not_found'
              );
            }
            const updated = [...processes];
            updated[idx] = {
              ...updated[idx],
              launch_mode: mode,
              autolaunch: mode !== 'off',
              schedule: blocks
                ? { mode, blocks }
                : { mode },
              // Mirror to the legacy `schedules` field that the agent reads.
              schedules: blocks,
            };
            return { processes: updated, result: undefined };
          });
        } catch (e) {
          if (e instanceof ProcessConfigError) {
            return problem(e.status, e.code || 'process_config_error', e.message);
          }
          throw e;
        }

        emitMutation({
          kind: 'process_mutated',
          siteId,
          actor: ctx.auth.keyContext
            ? `apiKey:${ctx.auth.keyContext.keyId}`
            : `user:${ctx.actor.userId}`,
          targetId: processId,
          attributes: {
            verb: 'schedule',
            endpoint: 'processes/schedule',
            method: 'POST',
            machineId,
            mode,
          },
        });

        logger.info(`Process schedule updated: ${processId} on ${machineId} (mode=${mode})`, {
          context: 'sites/machines/processes',
        });

        return NextResponse.json({ ok: true, data: { processId, mode } });
      },
      { requireKey: true },
    );
  } catch (error: unknown) {
    return errorResponse(error, 'sites/machines/processes/schedule');
  }
});

export const POST = withRateLimit(wrapped, {
  strategy: 'api',
  identifier: 'ip',
});

function problem(status: number, code: string, detail: string): NextResponse {
  return NextResponse.json(
    { type: 'about:blank', title: code, status, code, detail },
    { status, headers: { 'Content-Type': 'application/problem+json' } }
  );
}

function errorResponse(error: unknown, ctx: string): NextResponse {
  if (error instanceof ApiAuthError) {
    return problem(error.status, error.status === 403 ? 'scope_insufficient' : 'unauthorized', error.message);
  }
  if (error instanceof ProcessConfigError) {
    return problem(error.status, error.code || 'process_config_error', error.message);
  }
  console.error(`${ctx}:`, error);
  return problem(500, 'internal_error', error instanceof Error ? error.message : 'Internal server error');
}
