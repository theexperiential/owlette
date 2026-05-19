/**
 * deleteUser action core (security-boundary-migration wave 3.9).
 *
 * Thin wrapper around `performUserDeleteCascade` — the cascade lives in
 * `web/lib/userDeleteCascade.server.ts` (orphan-sites guard, successor
 * validation, site ownership transfer, api-key revocation, command sweep,
 * `users/{uid}.deletedAt` write). This action core re-exports the cascade
 * via the shared action-core call shape so callers (the route shim, future
 * cortex tools, scheduled jobs) all use the same entry point.
 *
 * Capability: `USER_DELETE` — wrapper-enforced (superadmin only).
 *
 * Idempotency: re-issuing on an already-deleted user returns `already_deleted`
 * with the original `deletedAt`; no further side-effects.
 */

import {
  performUserDeleteCascade,
  type UserDeleteOutcome,
} from '@/lib/userDeleteCascade.server';
import { emitMutation } from '@/lib/auditLogClient';

export interface DeleteUserInput {
  uid: string;
  /** Required when the user owns sites; rejected otherwise. */
  successorUid?: string | null;
}

export interface DeleteUserContext {
  /** Audit actor string ("user:<uid>" or "apiKey:<keyId>"). */
  auditActor: string;
  endpoint?: string;
  method?: string;
}

export type DeleteUserResult = UserDeleteOutcome;

export async function deleteUser(
  ctx: DeleteUserContext,
  input: DeleteUserInput,
): Promise<DeleteUserResult> {
  if (!input.uid) throw new Error('uid is required');

  const result = await performUserDeleteCascade(input.uid, {
    successorUid: input.successorUid ?? null,
  });

  if (result.kind === 'deleted') {
    emitMutation({
      kind: 'user_mutated',
      siteId: '',
      actor: ctx.auditActor,
      targetId: input.uid,
      attributes: {
        endpoint: ctx.endpoint ?? '',
        method: ctx.method ?? 'DELETE',
        verb: 'soft_deleted',
        successorUid: input.successorUid ?? null,
        transferredSites: result.transferredSites,
        revokedKeyCount: result.revokedKeyIds.length,
        authDisabled: result.authDisabled,
      },
    });
  }

  return result;
}
