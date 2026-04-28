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
import { validateUpdateProcessFields } from '@/lib/processPayloadValidation';

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
  const validation = validateUpdateProcessFields(patch as Record<string, unknown>);
  if (!validation.ok) {
    throw new ActionInputError(
      validation.error.status,
      validation.error.code,
      validation.error.detail,
    );
  }
  const safePatch = validation.value;

  await withProcessLock(ctx.siteId, machineId, (processes) => {
    const idx = findProcessIndex(processes, processId);
    if (idx === -1) {
      throw new ProcessConfigError(404, `Process ${processId} not found`, 'process_not_found');
    }
    const updated = [...processes];
    if (safePatch.launch_mode === 'scheduled') {
      const schedules = safePatch.schedules ?? updated[idx].schedules;
      if (!Array.isArray(schedules) || schedules.length === 0) {
        throw new ActionInputError(
          400,
          'missing_schedules',
          'Schedules array is required when launch_mode is "scheduled".',
        );
      }
    }
    const merged: PublicProcessConfig = {
      ...updated[idx],
      ...safePatch,
      // Re-pin id fields so a malicious body can't override them.
      id: processId,
      processId,
    };
    if (typeof safePatch.launch_mode === 'string') {
      merged.autolaunch = safePatch.launch_mode !== 'off';
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
