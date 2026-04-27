/**
 * PATCH /api/sites/{siteId}/machines/{machineId}/processes/{processId}/launch-mode
 *
 * Canonical site-scoped route for setting a process's launch mode and
 * optional schedule. Atomic: writes both the config doc and the machine
 * status doc.
 *
 * security-boundary-migration wave 3.2: capability `MACHINE_CONFIG_WRITE`,
 * api-key scope `machine=<id>:write`.
 *
 * Request body:
 *   mode: 'off' | 'always' | 'scheduled'
 *   schedules?: ScheduleBlock[]      // required when mode='scheduled'
 *   schedulePresetId?: string | null
 */
import { NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { resolveAuth } from '@/lib/apiAuth.server';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import { withIdempotency } from '@/lib/idempotency';
import { ProcessConfigError, type ScheduleBlock } from '@/lib/processConfig.server';
import {
  setProcessLaunchMode,
  type LaunchMode,
  type SetProcessLaunchModeInput,
  VALID_LAUNCH_MODES,
} from '@/lib/actions/setProcessLaunchMode.server';
import { ActionInputError } from '@/lib/actions/createProcess.server';

const wrapped = authorizedSiteHandler<{
  siteId: string;
  machineId: string;
  processId: string;
}>({
  capability: 'MACHINE_CONFIG_WRITE',
  siteIdParam: 'path',
  targetKind: 'process',
  targetIdParam: 'processId',
  apiKeyScope: { resource: 'machine', idParam: 'machineId', permission: 'write' },
})(async (request, ctx, routeContext) => {
  try {
    const { machineId, processId } = await routeContext.params;

    const rawBody = await request.text();
    let body: Record<string, unknown>;
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      return problem(400, 'invalid_body', 'Request body must be valid JSON.');
    }

    const auth = await resolveAuth(request);

    return withIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.keyContext?.environment ?? 'unknown',
      },
      rawBody,
      async () => {
        const auditActor = auth.keyContext
          ? `apiKey:${auth.keyContext.keyId}`
          : `user:${auth.userId}`;

        const mode = body.mode;
        if (typeof mode !== 'string' || !VALID_LAUNCH_MODES.includes(mode as LaunchMode)) {
          return problem(
            400,
            'invalid_mode',
            `Invalid mode. Must be one of: ${VALID_LAUNCH_MODES.join(', ')}`,
          );
        }

        const input: SetProcessLaunchModeInput = {
          machineId,
          processId,
          mode: mode as LaunchMode,
          ...(body.schedules !== undefined
            ? { schedules: body.schedules as ScheduleBlock[] }
            : {}),
          ...(body.schedulePresetId !== undefined
            ? { schedulePresetId: body.schedulePresetId as string | null }
            : {}),
        };

        try {
          const result = await setProcessLaunchMode(
            { siteId: ctx.siteId, actor: ctx.actor, auditActor },
            input,
          );
          return NextResponse.json({
            ok: true,
            data: { processId: result.processId, mode: result.mode },
          });
        } catch (e) {
          return mapActionError(e);
        }
      },
    );
  } catch (error: unknown) {
    if (error instanceof ActionInputError) {
      return problem(error.status, error.code, error.message);
    }
    if (error instanceof ProcessConfigError) {
      return problem(
        error.status,
        error.code || 'process_config_error',
        error.message,
      );
    }
    console.error('sites/machines/processes/launch-mode:', error);
    return problem(
      500,
      'internal_error',
      error instanceof Error ? error.message : 'Internal server error',
    );
  }
});

export const PATCH = withRateLimit(wrapped, {
  strategy: 'api',
  identifier: 'ip',
});

function problem(status: number, code: string, detail: string): NextResponse {
  return NextResponse.json(
    { type: 'about:blank', title: code, status, code, detail },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

function mapActionError(error: unknown): NextResponse {
  if (error instanceof ActionInputError) {
    return problem(error.status, error.code, error.message);
  }
  if (error instanceof ProcessConfigError) {
    return problem(error.status, error.code || 'process_config_error', error.message);
  }
  throw error;
}
