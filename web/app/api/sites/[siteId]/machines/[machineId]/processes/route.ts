/**
 * Public Scoped Process API — list + create
 *
 * `GET  /api/sites/{siteId}/machines/{machineId}/processes`
 * `POST /api/sites/{siteId}/machines/{machineId}/processes`
 *
 * Wave 2 / Track 2B of the api-sprint. Mirrors the admin route
 * (`/api/admin/processes`) but with public scoping (`machine=<id>:read|write`),
 * RFC-7807 problem+json errors, idempotency-key on POST create, and the
 * race-safe `withProcessLock` transaction helper.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { withIdempotency } from '@/lib/idempotency';
import { emitMutation } from '@/lib/auditLogClient';
import {
  withProcessLock,
  readProcessList,
  generateProcessId,
  ProcessConfigError,
  PublicProcessConfig,
} from '@/lib/processConfig.server';
import { requireMachineAuthAndScope } from '@/app/api/_shared';
import logger from '@/lib/logger';

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
        // Live status keyed by processId (preferred) OR legacy id OR name.
        const live =
          liveProcesses[p.processId] ||
          liveProcesses[p.id] ||
          liveProcesses[p.name] ||
          {};
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

export const POST = withRateLimit(
  async (request: NextRequest, context: RouteContext) => {
    try {
      const { siteId, machineId } = await context.params;
      const auth = await requireMachineAuthAndScope(request, siteId, machineId, 'write');
      if (!auth.ok) return auth.response;

      const rawBody = await request.text();
      let body: Record<string, unknown>;
      try {
        body = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        return problem(400, 'invalid_body', 'Request body must be valid JSON.');
      }

      const name = typeof body.name === 'string' ? body.name : '';
      const exePath = typeof body.exe_path === 'string' ? body.exe_path : '';

      if (!name) {
        return problem(400, 'missing_field', 'Field `name` is required.');
      }
      if (!exePath) {
        return problem(400, 'missing_field', 'Field `exe_path` is required.');
      }
      if ('processId' in body) {
        return problem(400, 'forbidden_field', 'Field `processId` is server-generated; do not include it.');
      }

      return withIdempotency(
        request,
        {
          userId: auth.userId,
          environment: auth.auth.keyContext?.environment ?? 'unknown',
        },
        rawBody,
        async () => {
          const newProcessId = generateProcessId();
          const launchMode = (body.launch_mode as string) || 'off';

          try {
            await withProcessLock(siteId, machineId, (processes) => {
              const newProcess: PublicProcessConfig = {
                id: newProcessId,
                processId: newProcessId,
                name,
                exe_path: exePath,
                file_path: (body.file_path as string) || '',
                cwd: (body.cwd as string) || '',
                priority: (body.priority as string) || 'Normal',
                visibility: (body.visibility as string) || 'Show',
                time_delay: (body.time_delay as string) || '0',
                time_to_init: (body.time_to_init as string) || '10',
                relaunch_attempts: (body.relaunch_attempts as string) || '3',
                autolaunch: launchMode !== 'off',
                launch_mode: launchMode as 'off' | 'always' | 'scheduled',
                schedules: (body.schedules as PublicProcessConfig['schedules']) ?? null,
              };
              return {
                processes: [...processes, newProcess],
                result: newProcessId,
              };
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
            targetId: newProcessId,
            attributes: { verb: 'create', endpoint: 'processes', method: 'POST', machineId },
          });

          logger.info(`Process created: ${name} on ${machineId}`, {
            context: 'sites/machines/processes',
          });

          return NextResponse.json(
            { ok: true, data: { processId: newProcessId } },
            { status: 201 }
          );
        }
      );
    } catch (error: unknown) {
      return errorResponse(error, 'sites/machines/processes POST');
    }
  },
  { strategy: 'api', identifier: 'ip' }
);

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
