/**
 * Action core: toggle the per-site `requireTier3Approval` Cortex policy.
 *
 * Writes `sites/{siteId}/settings/cortex.requireTier3Approval`. When `true`
 * (the default), privileged tier-3 tool calls (run_powershell, execute_script,
 * reboot_machine, etc.) pause for explicit in-chat approval before they run,
 * and single-machine admin chats are routed through the server-side LLM path
 * so the AI SDK approval gate can fire. When `false`, local Cortex is allowed
 * and the gate does not apply.
 *
 * Read side: `getCortexRequireTier3Approval` in `lib/cortex-utils.server.ts`.
 */
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { emitMutation } from '@/lib/auditLogClient';
import logger from '@/lib/logger';
import { ActionInputError, type ActionContext } from './createProcess.server';

export interface SetCortexRequireTier3ApprovalInput {
  requireTier3Approval: boolean;
}

export interface SetCortexRequireTier3ApprovalResult {
  siteId: string;
  requireTier3Approval: boolean;
}

export async function setCortexRequireTier3Approval(
  ctx: ActionContext,
  input: SetCortexRequireTier3ApprovalInput,
): Promise<SetCortexRequireTier3ApprovalResult> {
  if (typeof input.requireTier3Approval !== 'boolean') {
    throw new ActionInputError(
      400,
      'invalid_require_tier3_approval',
      'Field `requireTier3Approval` must be a boolean.',
    );
  }

  const db = getAdminDb();
  await db
    .collection('sites')
    .doc(ctx.siteId)
    .collection('settings')
    .doc('cortex')
    .set(
      {
        requireTier3Approval: input.requireTier3Approval,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

  emitMutation({
    kind: 'site_mutated',
    siteId: ctx.siteId,
    actor: ctx.auditActor,
    targetId: ctx.siteId,
    attributes: {
      verb: 'set_cortex_require_tier3_approval',
      endpoint: 'cortex-settings',
      method: 'PATCH',
      requireTier3Approval: input.requireTier3Approval,
    },
  });

  logger.info(
    `Cortex tier-3 approval ${input.requireTier3Approval ? 'required' : 'disabled'} on site ${ctx.siteId}`,
    { context: 'actions/setCortexRequireTier3Approval' },
  );

  return { siteId: ctx.siteId, requireTier3Approval: input.requireTier3Approval };
}
