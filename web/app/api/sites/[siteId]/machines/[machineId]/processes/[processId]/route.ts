/**
 * Public Scoped Process API — detail / update / delete
 *
 * `GET    /api/sites/{siteId}/machines/{machineId}/processes/{processId}`
 * `PATCH  /api/sites/{siteId}/machines/{machineId}/processes/{processId}`
 * `DELETE /api/sites/{siteId}/machines/{machineId}/processes/{processId}`
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
  findProcessIndex,
  ProcessConfigError,
  PublicProcessConfig,
} from '@/lib/processConfig.server';
import { requireMachineAuthAndScope } from '@/app/api/_shared';
import logger from '@/lib/logger';

interface RouteContext {
  params: Promise<{ siteId: string; machineId: string; processId: string }>;
}

/* -------------------------------------------------------------------------- */
/*  GET — single process detail                                               */
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

      const live =
        ((statusSnap.exists ? statusSnap.data() : null)?.metrics?.processes?.[
          processId
        ] as Record<string, unknown>) || {};

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
/*  PATCH — partial update                                                    */
/* -------------------------------------------------------------------------- */

export const PATCH = withRateLimit(
  async (request: NextRequest, context: RouteContext) => {
    try {
      const { siteId, machineId, processId } = await context.params;
      const auth = await requireMachineAuthAndScope(request, siteId, machineId, 'write');
      if (!auth.ok) return auth.response;

      const rawBody = await request.text();
      let body: Record<string, unknown>;
      try {
        body = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        return problem(400, 'invalid_body', 'Request body must be valid JSON.');
      }

      // Strip server-managed fields. Returning 400 (vs silent strip) makes
      // tampering attempts visible to clients.
      if ('processId' in body || 'id' in body) {
        return problem(400, 'forbidden_field', 'Cannot mutate `processId` or `id`.');
      }

      if (Object.keys(body).length === 0) {
        return problem(400, 'no_fields', 'Request body must contain at least one field to update.');
      }

      // PATCH idempotency-key is optional per api-surface convention but if
      // supplied we honour replay.
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
                throw new ProcessConfigError(404, `Process ${processId} not found`, 'process_not_found');
              }
              const updated = [...processes];
              const merged: PublicProcessConfig = {
                ...updated[idx],
                ...(body as Partial<PublicProcessConfig>),
                // Re-pin id fields so a malicious body can't override them
                // even if the field check above is bypassed.
                id: processId,
                processId,
              };
              // If launch_mode is being set, mirror autolaunch (matches admin).
              if (typeof body.launch_mode === 'string') {
                merged.autolaunch = body.launch_mode !== 'off';
              }
              updated[idx] = merged;
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
            attributes: { verb: 'update', endpoint: 'processes', method: 'PATCH', machineId },
          });

          logger.info(`Process updated: ${processId} on ${machineId}`, {
            context: 'sites/machines/processes',
          });

          return NextResponse.json({ ok: true, data: { processId } });
        }
      );
    } catch (error: unknown) {
      return errorResponse(error, 'sites/machines/processes/[id] PATCH');
    }
  },
  { strategy: 'api', identifier: 'ip' }
);

/* -------------------------------------------------------------------------- */
/*  DELETE — remove from array (true-idempotent: 200 on missing)              */
/* -------------------------------------------------------------------------- */

export const DELETE = withRateLimit(
  async (request: NextRequest, context: RouteContext) => {
    try {
      const { siteId, machineId, processId } = await context.params;
      const auth = await requireMachineAuthAndScope(request, siteId, machineId, 'write');
      if (!auth.ok) return auth.response;

      let alreadyDeleted = false;

      try {
        await withProcessLock(siteId, machineId, (processes) => {
          const idx = findProcessIndex(processes, processId);
          if (idx === -1) {
            alreadyDeleted = true;
            return { processes, result: undefined };
          }
          return {
            processes: processes.filter((p) => p.processId !== processId),
            result: undefined,
          };
        });
      } catch (e) {
        if (e instanceof ProcessConfigError && e.status === 404) {
          // Config doc itself is missing — also "already deleted" semantics.
          alreadyDeleted = true;
        } else if (e instanceof ProcessConfigError) {
          return problem(e.status, e.code || 'process_config_error', e.message);
        } else {
          throw e;
        }
      }

      // Emit audit even on no-op delete for traceability.
      emitMutation({
        kind: 'process_mutated',
        siteId,
        actor: auth.auth.keyContext
          ? `apiKey:${auth.auth.keyContext.keyId}`
          : `user:${auth.userId}`,
        targetId: processId,
        attributes: {
          verb: 'delete',
          endpoint: 'processes',
          method: 'DELETE',
          machineId,
          alreadyDeleted,
        },
      });

      logger.info(`Process deleted: ${processId} on ${machineId} (alreadyDeleted=${alreadyDeleted})`, {
        context: 'sites/machines/processes',
      });

      return NextResponse.json({ ok: true, data: { processId, alreadyDeleted } });
    } catch (error: unknown) {
      return errorResponse(error, 'sites/machines/processes/[id] DELETE');
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
