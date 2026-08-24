/**
 * Toggle the per-site Hoot `requireTier3Approval` policy, stored at
 * `sites/{siteId}/settings/cortex` (the `cortex` doc name is the storage
 * contract; the UI says "hoot").
 *
 * True (default): tier-3 tool calls pause for in-chat approval, and
 * single-machine admin chats route through the server LLM path so the AI SDK
 * gate can fire. False: local Hoot is allowed and the gate never applies.
 * Read side: `getHootRequireTier3Approval` in `lib/hoot-utils.server.ts`.
 */
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { emitMutation } from '@/lib/auditLogClient';
import logger from '@/lib/logger';
import { ActionInputError, type ActionContext } from './createProcess.server';

export interface SetHootRequireTier3ApprovalInput {
  requireTier3Approval: boolean;
}

export interface SetHootRequireTier3ApprovalResult {
  siteId: string;
  requireTier3Approval: boolean;
}

export async function setHootRequireTier3Approval(
  ctx: ActionContext,
  input: SetHootRequireTier3ApprovalInput,
): Promise<SetHootRequireTier3ApprovalResult> {
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
    `Hoot tier-3 approval ${input.requireTier3Approval ? 'required' : 'disabled'} on site ${ctx.siteId}`,
    { context: 'actions/setHootRequireTier3Approval' },
  );

  return { siteId: ctx.siteId, requireTier3Approval: input.requireTier3Approval };
}
