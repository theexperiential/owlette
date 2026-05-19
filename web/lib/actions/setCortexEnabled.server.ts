/**
 * Action core: toggle the per-machine `cortexEnabled` flag.
 *
 * Writes `sites/{siteId}/machines/{machineId}.cortexEnabled` (the live
 * machine status doc — NOT the config doc). When `false`, cortex tool
 * calls (manual chat + autonomous investigations) are blocked at the
 * dispatch layer for that machine. The agent stays online for monitoring.
 */
import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';
import logger from '@/lib/logger';
import { ActionInputError, type ActionContext } from './createProcess.server';

export interface SetCortexEnabledInput {
  machineId: string;
  enabled: boolean;
}

export interface SetCortexEnabledResult {
  machineId: string;
  enabled: boolean;
}

export async function setCortexEnabled(
  ctx: ActionContext,
  input: SetCortexEnabledInput,
): Promise<SetCortexEnabledResult> {
  if (typeof input.enabled !== 'boolean') {
    throw new ActionInputError(400, 'invalid_enabled', 'Field `enabled` must be a boolean.');
  }

  const db = getAdminDb();
  const machineRef = db
    .collection('sites')
    .doc(ctx.siteId)
    .collection('machines')
    .doc(input.machineId);

  await machineRef.update({ cortexEnabled: input.enabled });

  emitMutation({
    kind: 'process_mutated',
    siteId: ctx.siteId,
    actor: ctx.auditActor,
    targetId: input.machineId,
    attributes: {
      verb: 'set_cortex_enabled',
      endpoint: 'cortex-enabled',
      method: 'PATCH',
      machineId: input.machineId,
      enabled: input.enabled,
    },
  });

  logger.info(`Cortex ${input.enabled ? 'enabled' : 'disabled'} on ${input.machineId}`, {
    context: 'actions/setCortexEnabled',
  });

  return { machineId: input.machineId, enabled: input.enabled };
}
