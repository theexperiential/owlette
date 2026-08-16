/**
 * deleteUser action core (security-boundary-migration wave 3.9).
 *
 * Thin wrapper around `performUserDeleteCascade` — the cascade lives in
 * `web/lib/userDeleteCascade.server.ts` (orphan-sites guard, successor
 * validation, site ownership transfer, api-key revocation, command sweep,
 * `users/{uid}.deletedAt` write). This action core re-exports the cascade
 * via the shared action-core call shape so callers (the route shim, future
 * hoot tools, scheduled jobs) all use the same entry point.
 *
 * Capability: `USER_DELETE` — wrapper-enforced (superadmin only).
 *
 * Idempotency: re-issuing on an already-deleted user returns `already_deleted`
 * with the original `deletedAt`; no further side-effects.
 *
 * Authored talons: the cascade refuses to orphan the SITES a user owns, but
 * says nothing about the automations they wrote — and a talon with a hoot
 * output resolves its author's site access on every run, so soft-deleting the
 * author stops it dead. Every successful delete now reports
 * `authoredTalonCount`, and `reassignTalons: true` hands them to the successor
 * already being named for site ownership rather than asking twice.
 */

import {
  performUserDeleteCascade,
  type UserDeleteOutcome,
} from '@/lib/userDeleteCascade.server';
import { emitMutation } from '@/lib/auditLogClient';
import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';
import {
  listTalonsAuthoredByAcrossSites,
  reassignTalons,
  TalonStoreError,
  type AuthoredTalonRef,
} from '@/lib/talons/store.server';
import type { Actor } from '@/lib/capabilities';
import type { Firestore } from 'firebase-admin/firestore';

export interface DeleteUserInput {
  uid: string;
  /** Required when the user owns sites; rejected otherwise. */
  successorUid?: string | null;
  /**
   * Hand the talons this user authored to `successorUid` as part of the
   * delete. Opt-in, and never implied by `successorUid` alone: an api client
   * that has always passed a successor for site ownership must not discover
   * that it now rewrites authorship too. The dashboard sets it only after the
   * operator has been shown the count.
   */
  reassignTalons?: boolean;
  /** Inject a Firestore instance — tests pass a mock; production omits. */
  db?: Firestore;
}

export interface DeleteUserContext {
  /** Audit actor string ("user:<uid>" or "apiKey:<keyId>"). */
  auditActor: string;
  /** The authorized caller — carried into the talon store's audit context. */
  actor: Actor;
  endpoint?: string;
  method?: string;
}

/** One site whose talons could not be moved, and why. */
export interface TalonReassignFailure {
  siteId: string;
  detail: string;
}

export type DeleteUserResult =
  | Exclude<UserDeleteOutcome, { kind: 'deleted' }>
  | (Extract<UserDeleteOutcome, { kind: 'deleted' }> & {
      /** Talons this user authored, fleet-wide, at the moment of deletion. */
      authoredTalonCount: number;
      reassignedTalonIds: string[];
      talonReassignFailures: TalonReassignFailure[];
    });

/**
 * Move the deleted user's talons to the successor, one site at a time.
 *
 * Per-site because eligibility is per-site: an admin successor may be a member
 * of one of the departing user's sites and not another, and the store is right
 * to refuse the second. A refusal is recorded and the sweep continues — the
 * account is already deleted at this point, so aborting would only mean fewer
 * talons rescued and no way to report which.
 */
async function reassignAuthoredTalons(
  db: Firestore,
  ctx: DeleteUserContext,
  authored: AuthoredTalonRef[],
  successorUid: string,
): Promise<{ reassignedTalonIds: string[]; failures: TalonReassignFailure[] }> {
  const bySite = new Map<string, string[]>();
  for (const talon of authored) {
    const ids = bySite.get(talon.siteId);
    if (ids) ids.push(talon.talonId);
    else bySite.set(talon.siteId, [talon.talonId]);
  }

  const reassignedTalonIds: string[] = [];
  const failures: TalonReassignFailure[] = [];

  for (const [siteId, talonIds] of bySite) {
    try {
      const result = await reassignTalons(
        db,
        {
          siteId,
          actor: ctx.actor,
          auditActor: ctx.auditActor,
          via: 'ui',
          endpoint: ctx.endpoint ?? '',
          method: ctx.method ?? 'DELETE',
        },
        successorUid,
        { talonIds },
      );
      reassignedTalonIds.push(...result.reassignedTalonIds);
    } catch (err) {
      const detail =
        err instanceof TalonStoreError || err instanceof Error
          ? err.message
          : String(err);
      failures.push({ siteId, detail });
      logger.warn(`deleteUser: talon reassign failed on ${siteId}: ${detail}`, {
        context: 'actions/deleteUser',
        data: { uid: successorUid, siteId },
      });
    }
  }

  return { reassignedTalonIds, failures };
}

export async function deleteUser(
  ctx: DeleteUserContext,
  input: DeleteUserInput,
): Promise<DeleteUserResult> {
  if (!input.uid) throw new Error('uid is required');

  const result = await performUserDeleteCascade(input.uid, {
    successorUid: input.successorUid ?? null,
  });

  if (result.kind !== 'deleted') return result;

  // After the cascade, not before: the refusal paths (`orphan_sites`,
  // `successor_invalid`, `already_deleted`) must not pay for a query whose
  // answer they'd discard, and soft-deleting the author doesn't touch
  // `createdBy`, so the answer is the same either side of it.
  const db = input.db ?? getAdminDb();
  const authored = await listTalonsAuthoredByAcrossSites(db, input.uid);

  let reassignedTalonIds: string[] = [];
  let talonReassignFailures: TalonReassignFailure[] = [];
  if (input.reassignTalons && input.successorUid && authored.length > 0) {
    const outcome = await reassignAuthoredTalons(db, ctx, authored, input.successorUid);
    reassignedTalonIds = outcome.reassignedTalonIds;
    talonReassignFailures = outcome.failures;
  }

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
      authoredTalonCount: authored.length,
      reassignedTalonCount: reassignedTalonIds.length,
    },
  });

  return {
    ...result,
    authoredTalonCount: authored.length,
    reassignedTalonIds,
    talonReassignFailures,
  };
}
