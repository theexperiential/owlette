/**
 * Public Scoped Process API — list + create
 *
 * `GET  /api/sites/{siteId}/machines/{machineId}/processes`
 * `POST /api/sites/{siteId}/machines/{machineId}/processes`
 *
 * Wave 2 / Track 2B of the api-sprint. Canonical site-scoped process surface
 * with public scoping (`machine=<id>:read|write`), RFC-7807 problem+json
 * errors, idempotency-key on POST create, and the race-safe `withProcessLock`
 * transaction helper.
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
import {
  createProcess,
  ActionInputError,
} from '@/lib/actions/createProcess.server';
import { validateCreateProcessFields } from '@/lib/processPayloadValidation';
import { lookupLiveProcessStatus } from '@/lib/processResponse.server';

interface RouteContext {
  params: Promise<{ siteId: string; machineId: string }>;
}

/* -------------------------------------------------------------------------- */
/*  GET — list processes (config + live status merge)                         */
/* -------------------------------------------------------------------------- */

export const GET = withRateLimit(
  async (request: NextRequest, context: RouteContext) => {
    try {
      const { siteId, machineId } = await context.params;
      const auth = await requireMachineAuthAndScope(request, siteId, machineId, 'read');
      if (!auth.ok) return auth.response;

      const db = getAdminDb();
      const [configProcesses, statusSnap] = await Promise.all([
        readProcessList(siteId, machineId),
        db.collection('sites').doc(siteId).collection('machines').doc(machineId).get(),
      ]);

      if (configProcesses === null) {
        // Config doc doesn't exist yet — treat as empty list, not 404.
        return NextResponse.json({
          ok: true,
          data: { processes: [], nextPageToken: null },
        });
      }

      const statusData = statusSnap.exists ? statusSnap.data() : null;
      const liveProcesses = (statusData?.metrics?.processes || {}) as Record<
        string,
        Record<string, unknown>
      >;

      const merged = configProcesses.map((p) => {
        const live = lookupLiveProcessStatus(p, liveProcesses);
        return shapeProcessForResponse(p, live);
      });

      return NextResponse.json({
        ok: true,
        data: { processes: merged, nextPageToken: null },
      });
    } catch (error: unknown) {
      return errorResponse(error, 'sites/machines/processes GET');
    }
  },
  { strategy: 'api', identifier: 'ip' }
);

/* -------------------------------------------------------------------------- */
/*  POST — create a new process                                               */
/* -------------------------------------------------------------------------- */

const postWrapped = authorizedSiteHandler<{ siteId: string; machineId: string }>({
  capability: 'MACHINE_CONFIG_WRITE',
  siteIdParam: 'path',
  targetKind: 'machine',
  targetIdParam: 'machineId',
  apiKeyScope: { resource: 'machine', idParam: 'machineId', permission: 'write' },
})(async (request, ctx, routeContext) => {
  try {
    const { machineId } = await routeContext.params;

    const rawBody = await request.text();
    let body: Record<string, unknown>;
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      return problem(400, 'invalid_body', 'Request body must be valid JSON.');
    }

    const validation = validateCreateProcessFields(body);
    if (!validation.ok) {
      return problem(validation.error.status, validation.error.code, validation.error.detail);
    }

    const auth = await resolveAuth(request);
    const auditActor = auth.keyContext
      ? `apiKey:${auth.keyContext.keyId}`
      : `user:${auth.userId}`;

    return withIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.keyContext?.environment ?? 'unknown',
      },
      rawBody,
      async () => {
        try {
          const result = await createProcess(
            { siteId: ctx.siteId, actor: ctx.actor, auditActor },
            { machineId, ...validation.value },
          );
          return NextResponse.json(
            { ok: true, data: { processId: result.processId } },
            { status: 201 }
          );
        } catch (e) {
          const mapped = mapActionError(e);
          if (mapped) return mapped;
          throw e;
        }
      },
      { requireKey: true },
    );
  } catch (error: unknown) {
    return errorResponse(error, 'sites/machines/processes POST');
  }
});

export const POST = withRateLimit(postWrapped, {
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
    // Live status fields (shape-merged from agent metrics).
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
