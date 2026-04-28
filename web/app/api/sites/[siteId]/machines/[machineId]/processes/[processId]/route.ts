/**
 * Public Scoped Process API - detail / update / delete
 *
 * `GET    /api/sites/{siteId}/machines/{machineId}/processes/{processId}`
 * `PATCH  /api/sites/{siteId}/machines/{machineId}/processes/{processId}`
 * `DELETE /api/sites/{siteId}/machines/{machineId}/processes/{processId}`
 */

import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, resolveAuth } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { withIdempotency } from '@/lib/idempotency';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import {
  readProcessList,
  ProcessConfigError,
  PublicProcessConfig,
} from '@/lib/processConfig.server';
import { requireMachineAuthAndScope } from '@/app/api/_shared';
import { ActionInputError } from '@/lib/actions/createProcess.server';
import { updateProcess } from '@/lib/actions/updateProcess.server';
import { deleteProcess } from '@/lib/actions/deleteProcess.server';
import { validateUpdateProcessFields } from '@/lib/processPayloadValidation';
import { lookupLiveProcessStatus } from '@/lib/processResponse.server';

interface RouteContext {
  params: Promise<{ siteId: string; machineId: string; processId: string }>;
}

/* -------------------------------------------------------------------------- */
/*  GET - single process detail                                               */
/* -------------------------------------------------------------------------- */

export const GET = withRateLimit(
  async (request: NextRequest, context: RouteContext) => {
    try {
      const { siteId, machineId, processId } = await context.params;
      const auth = await requireMachineAuthAndScope(request, siteId, machineId, 'read');
      if (!auth.ok) return auth.response;

      const db = getAdminDb();
      const [processes, statusSnap] = await Promise.all([
        readProcessList(siteId, machineId),
        db.collection('sites').doc(siteId).collection('machines').doc(machineId).get(),
      ]);

      if (!processes) {
        return problem(404, 'process_not_found', 'No machine config found.');
      }

      const proc = processes.find((p) => p.processId === processId);
      if (!proc) {
        return problem(404, 'process_not_found', `Process ${processId} not found.`);
      }

      const liveProcesses = ((statusSnap.exists ? statusSnap.data() : null)?.metrics?.processes || {}) as Record<
        string,
        Record<string, unknown>
      >;
      const live = lookupLiveProcessStatus(proc, liveProcesses);

      return NextResponse.json({
        ok: true,
        data: shapeProcessForResponse(proc, live),
      });
    } catch (error: unknown) {
      return errorResponse(error, 'sites/machines/processes/[id] GET');
    }
  },
  { strategy: 'api', identifier: 'ip' }
);

/* -------------------------------------------------------------------------- */
/*  PATCH - partial update                                                    */
/* -------------------------------------------------------------------------- */

const patchWrapped = authorizedSiteHandler<{
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

    const validation = validateUpdateProcessFields(body);
    if (!validation.ok) {
      return problem(validation.error.status, validation.error.code, validation.error.detail);
    }

    const auth = await resolveAuth(request);
    const auditActor = auth.keyContext
      ? `apiKey:${auth.keyContext.keyId}`
      : `user:${auth.userId}`;

    // PATCH idempotency-key is optional per api-surface convention but if
    // supplied we honour replay.
    return withIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.keyContext?.environment ?? 'unknown',
      },
      rawBody,
      async () => {
        try {
          const result = await updateProcess(
            { siteId: ctx.siteId, actor: ctx.actor, auditActor },
            {
              machineId,
              processId,
              patch: validation.value as Partial<PublicProcessConfig>,
            },
          );
          return NextResponse.json({ ok: true, data: { processId: result.processId } });
        } catch (e) {
          const mapped = mapActionError(e);
          if (mapped) return mapped;
          throw e;
        }
      }
    );
  } catch (error: unknown) {
    return errorResponse(error, 'sites/machines/processes/[id] PATCH');
  }
});

export const PATCH = withRateLimit(patchWrapped, {
  strategy: 'api',
  identifier: 'ip',
});

/* -------------------------------------------------------------------------- */
/*  DELETE - remove from array (true-idempotent: 200 on missing)              */
/* -------------------------------------------------------------------------- */

const deleteWrapped = authorizedSiteHandler<{
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
    const auth = await resolveAuth(request);
    const auditActor = auth.keyContext
      ? `apiKey:${auth.keyContext.keyId}`
      : `user:${auth.userId}`;

    try {
      const result = await deleteProcess(
        { siteId: ctx.siteId, actor: ctx.actor, auditActor },
        { machineId, processId },
      );
      return NextResponse.json({ ok: true, data: result });
    } catch (e) {
      const mapped = mapActionError(e);
      if (mapped) return mapped;
      throw e;
    }
  } catch (error: unknown) {
    return errorResponse(error, 'sites/machines/processes/[id] DELETE');
  }
});

export const DELETE = withRateLimit(deleteWrapped, {
  strategy: 'api',
  identifier: 'ip',
});

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function shapeProcessForResponse(
  p: PublicProcessConfig,
  live: Record<string, unknown>
): Record<string, unknown> {
  return {
    processId: p.processId,
    name: p.name,
    exe_path: p.exe_path || '',
    file_path: p.file_path || '',
    cwd: p.cwd || '',
    priority: p.priority || 'Normal',
    visibility: p.visibility || 'Show',
    time_delay: p.time_delay || '0',
    time_to_init: p.time_to_init || '10',
    relaunch_attempts: p.relaunch_attempts || '3',
    autolaunch: p.autolaunch ?? false,
    launch_mode: p.launch_mode || 'off',
    schedules: p.schedules || null,
    schedule: p.schedule || null,
    schedulePresetId: p.schedulePresetId || null,
    status: (live.status as string) || 'unknown',
    pid: (live.pid as number) ?? null,
    responsive: (live.responsive as boolean) ?? false,
    last_updated: (live.last_updated as string | number) ?? null,
  };
}

function problem(status: number, code: string, detail: string): NextResponse {
  return NextResponse.json(
    { type: 'about:blank', title: code, status, code, detail },
    { status, headers: { 'Content-Type': 'application/problem+json' } }
  );
}

function mapActionError(error: unknown): NextResponse | null {
  if (error instanceof ActionInputError) {
    return problem(error.status, error.code, error.message);
  }
  if (error instanceof ProcessConfigError) {
    return problem(error.status, error.code || 'process_config_error', error.message);
  }
  return null;
}

function errorResponse(error: unknown, ctx: string): NextResponse {
  if (error instanceof ApiAuthError) {
    return problem(error.status, error.status === 403 ? 'scope_insufficient' : 'unauthorized', error.message);
  }
  if (error instanceof ActionInputError) {
    return problem(error.status, error.code, error.message);
  }
  if (error instanceof ProcessConfigError) {
    return problem(error.status, error.code || 'process_config_error', error.message);
  }
  console.error(`${ctx}:`, error);
  return problem(500, 'internal_error', error instanceof Error ? error.message : 'Internal server error');
}
