/**
 * Shared helpers for the process control-verb routes (kill / start / stop).
 *
 * Each control verb queues a command to `sites/{siteId}/machines/{machineId}/commands/pending`
 * keyed by a UUID. The agent picks it up on its next poll and dispatches.
 *
 * The `schedule` verb is intentionally NOT here — it goes through
 * `withProcessLock` (no command queue) and lives in its own route file.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { ApiAuthError } from '@/lib/apiAuth.server';
import { ProcessConfigError, readProcessList } from '@/lib/processConfig.server';
import { withIdempotency } from '@/lib/idempotency';
import { emitMutation } from '@/lib/auditLogClient';
import { requireMachineAuthAndScope } from '@/app/api/_shared';
import logger from '@/lib/logger';
import crypto from 'crypto';

export type ControlVerb = 'kill' | 'start' | 'stop';

interface RouteContext {
  params: Promise<{ siteId: string; machineId: string; processId: string }>;
}

const VERB_TO_COMMAND: Record<ControlVerb, string> = {
  kill: 'kill_process',
  start: 'start_process',
  stop: 'stop_process',
};

/**
 * Generic handler for a process control verb. Validates the process exists,
 * queues the corresponding command, emits audit, returns commandId.
 */
export async function handleControlVerb(
  verb: ControlVerb,
  request: NextRequest,
  context: RouteContext
): Promise<NextResponse> {
  try {
    const { siteId, machineId, processId } = await context.params;
    const auth = await requireMachineAuthAndScope(request, siteId, machineId, 'write');
    if (!auth.ok) return auth.response;

    const rawBody = await request.text();

    return withIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.auth.keyContext?.environment ?? 'unknown',
      },
      rawBody,
      async () => {
        // Verify the process exists (avoid queuing commands for ghost ids).
        const processes = await readProcessList(siteId, machineId);
        if (!processes) {
          return problem(404, 'process_not_found', 'No machine config found.');
        }
        const proc = processes.find((p) => p.processId === processId);
        if (!proc) {
          return problem(404, 'process_not_found', `Process ${processId} not found.`);
        }

        const commandType = VERB_TO_COMMAND[verb];
        const commandId = crypto.randomUUID();
        const db = getAdminDb();

        const pendingRef = db
          .collection('sites')
          .doc(siteId)
          .collection('machines')
          .doc(machineId)
          .collection('commands')
          .doc('pending');

        await pendingRef.set(
          {
            [commandId]: {
              type: commandType,
              processId,
              process_name: proc.name,
              timestamp: FieldValue.serverTimestamp(),
              status: 'pending',
            },
          },
          { merge: true }
        );

        emitMutation({
          kind: 'process_mutated',
          siteId,
          actor: auth.auth.keyContext
            ? `apiKey:${auth.auth.keyContext.keyId}`
            : `user:${auth.userId}`,
          targetId: processId,
          attributes: {
            verb,
            endpoint: `processes/${verb}`,
            method: 'POST',
            machineId,
            commandId,
            commandType,
          },
        });

        logger.info(`Process ${verb}: ${proc.name} on ${machineId} (cmd=${commandId})`, {
          context: 'sites/machines/processes',
        });

        return NextResponse.json(
          { ok: true, data: { commandId, status: 'pending' } },
          { status: 202 }
        );
      }
    );
  } catch (error: unknown) {
    return errorResponse(error, `sites/machines/processes/${verb}`);
  }
}

export function problem(status: number, code: string, detail: string): NextResponse {
  return NextResponse.json(
    { type: 'about:blank', title: code, status, code, detail },
    { status, headers: { 'Content-Type': 'application/problem+json' } }
  );
}

export function errorResponse(error: unknown, ctx: string): NextResponse {
  if (error instanceof ApiAuthError) {
    return problem(error.status, error.status === 403 ? 'scope_insufficient' : 'unauthorized', error.message);
  }
  if (error instanceof ProcessConfigError) {
    return problem(error.status, error.code || 'process_config_error', error.message);
  }
  console.error(`${ctx}:`, error);
  return problem(500, 'internal_error', error instanceof Error ? error.message : 'Internal server error');
}
