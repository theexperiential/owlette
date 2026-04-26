/**
 * Action core: partial-update a process on a machine.
 *
 * Extracted from `web/app/api/sites/[siteId]/machines/[machineId]/processes/[processId]/route.ts`
 * (PATCH).
 */
import {
  withProcessLock,
  findProcessIndex,
  ProcessConfigError,
  type PublicProcessConfig,
} from '@/lib/processConfig.server';
import { emitMutation } from '@/lib/auditLogClient';
import logger from '@/lib/logger';
import { ActionInputError, type ActionContext } from './createProcess.server';

export interface UpdateProcessInput {
  machineId: string;
  processId: string;
  /**
   * Partial process config. `id` and `processId` are forbidden — the route
   * shim already strips them, and any that slip past are re-pinned inside
   * the txn so a malicious body can't override them.
   */
  patch: Partial<PublicProcessConfig>;
}

export interface UpdateProcessResult {
  processId: string;
}

export async function updateProcess(
  ctx: ActionContext,
  input: UpdateProcessInput,
): Promise<UpdateProcessResult> {
  const { machineId, processId, patch } = input;

  if ('processId' in patch || 'id' in patch) {
    throw new ActionInputError(400, 'forbidden_field', 'Cannot mutate `processId` or `id`.');
  }
  if (Object.keys(patch).length === 0) {
    throw new ActionInputError(
      400,
      'no_fields',
      'Request body must contain at least one field to update.',
    );
  }

  await withProcessLock(ctx.siteId, machineId, (processes) => {
    const idx = findProcessIndex(processes, processId);
    if (idx === -1) {
      throw new ProcessConfigError(404, `Process ${processId} not found`, 'process_not_found');
    }
    const updated = [...processes];
    const merged: PublicProcessConfig = {
      ...updated[idx],
      ...patch,
      // Re-pin id fields so a malicious body can't override them.
      id: processId,
      processId,
    };
    if (typeof patch.launch_mode === 'string') {
      merged.autolaunch = patch.launch_mode !== 'off';
    }
    updated[idx] = merged;
    return { processes: updated, result: undefined };
  });

  emitMutation({
    kind: 'process_mutated',
    siteId: ctx.siteId,
    actor: ctx.auditActor,
    targetId: processId,
    attributes: {
      verb: 'update',
      endpoint: 'processes',
      method: 'PATCH',
      machineId,
    },
  });

  logger.info(`Process updated: ${processId} on ${machineId}`, {
    context: 'actions/updateProcess',
  });

  return { processId };
}
