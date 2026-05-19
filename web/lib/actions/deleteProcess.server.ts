/**
 * Action core: delete a process from a machine. True-idempotent — when
 * the process is already missing we return `alreadyDeleted: true` rather
 * than 404.
 *
 * Extracted from `web/app/api/sites/[siteId]/machines/[machineId]/processes/[processId]/route.ts`
 * (DELETE).
 */
import {
  withProcessLock,
  findProcessIndex,
  ProcessConfigError,
} from '@/lib/processConfig.server';
import { emitMutation } from '@/lib/auditLogClient';
import logger from '@/lib/logger';
import type { ActionContext } from './createProcess.server';

export interface DeleteProcessInput {
  machineId: string;
  processId: string;
}

export interface DeleteProcessResult {
  processId: string;
  alreadyDeleted: boolean;
}

export async function deleteProcess(
  ctx: ActionContext,
  input: DeleteProcessInput,
): Promise<DeleteProcessResult> {
  const { machineId, processId } = input;
  let alreadyDeleted = false;

  try {
    await withProcessLock(ctx.siteId, machineId, (processes) => {
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
    } else {
      throw e;
    }
  }

  emitMutation({
    kind: 'process_mutated',
    siteId: ctx.siteId,
    actor: ctx.auditActor,
    targetId: processId,
    attributes: {
      verb: 'delete',
      endpoint: 'processes',
      method: 'DELETE',
      machineId,
      alreadyDeleted,
    },
  });

  logger.info(
    `Process deleted: ${processId} on ${machineId} (alreadyDeleted=${alreadyDeleted})`,
    { context: 'actions/deleteProcess' },
  );

  return { processId, alreadyDeleted };
}
