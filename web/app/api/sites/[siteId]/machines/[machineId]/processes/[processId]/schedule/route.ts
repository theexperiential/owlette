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
import {
  withProcessLock,
  findProcessIndex,
  ProcessConfigError,
} from '@/lib/processConfig.server';
import { requireMachineAuthAndScope } from '@/app/api/_shared';
import logger from '@/lib/logger';

interface RouteContext {
  params: Promise<{ siteId: string; machineId: string; processId: string }>;
}

const VALID_MODES = ['off', 'always', 'scheduled'] as const;
type ScheduleMode = (typeof VALID_MODES)[number];

export const POST = withRateLimit(
  async (request: NextRequest, context: RouteContext) => {
    try {
      const { siteId, machineId, processId } = await context.params;
      const auth = await requireMachineAuthAndScope(request, siteId, machineId, 'write');
      if (!auth.ok) return auth.response;

      const rawBody = await request.text();
      let body: { mode?: string; blocks?: unknown };
      try {
        body = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        return problem(400, 'invalid_body', 'Request body must be valid JSON.');
      }

      const mode = body.mode;
      if (typeof mode !== 'string' || !VALID_MODES.includes(mode as ScheduleMode)) {
        return problem(
          400,
          'invalid_field',
          `Field \`mode\` must be one of: ${VALID_MODES.join(', ')}.`
        );
      }

      const blocks = Array.isArray(body.blocks) ? body.blocks : null;
      if (mode === 'scheduled' && (!blocks || blocks.length === 0)) {
        return problem(
          400,
          'invalid_field',
          'Field `blocks` is required and must be non-empty when `mode` is `scheduled`.'
        );
      }

      return withIdempotency(
        request,
        {
          userId: auth.userId,
          environment: auth.auth.keyContext?.environment ?? 'unknown',
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
                launch_mode: mode as ScheduleMode,
                autolaunch: mode !== 'off',
                schedule: blocks
                  ? { mode: mode as ScheduleMode, blocks: blocks as { days: string[]; ranges: { start: string; stop: string }[] }[] }
                  : { mode: mode as ScheduleMode },
                // Mirror to the legacy `schedules` field that the agent reads.
                schedules: (blocks as { days: string[]; ranges: { start: string; stop: string }[] }[] | null) ?? null,
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
            actor: auth.auth.keyContext
              ? `apiKey:${auth.auth.keyContext.keyId}`
              : `user:${auth.userId}`,
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
        }
      );
    } catch (error: unknown) {
      return errorResponse(error, 'sites/machines/processes/schedule');
    }
  },
  { strategy: 'api', identifier: 'ip' }
);

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
