/**
 * Removes siteIds from `users/{uid}.sites[]`, then best-effort cancels the
 * user's pending commands on those sites. The arrayRemove is authoritative —
 * a failed cancel sweep does not roll back membership.
 *
 * Capability `SITE_MEMBER_MANAGE`, enforced by the wrapper.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';
import { cancelUserCommandsOnSites } from '@/lib/userDeleteCascade.server';
import logger from '@/lib/logger';

export const MAX_SITES_PER_REQUEST = 100;
const SITE_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

export interface RemoveSiteFromUserInput {
  uid: string;
  siteIds: string[];
  /** Injected in tests; production omits both. */
  db?: Firestore;
  cancelCommands?: (uid: string, siteIds: string[]) => Promise<number>;
}

export interface RemoveSiteFromUserContext {
  auditActor: string;
  endpoint?: string;
  method?: string;
}

export type RemoveSiteFromUserResult =
  | { kind: 'not_found' }
  | { kind: 'invalid_format'; malformed: string[] }
  | { kind: 'too_many'; count: number; max: number }
  | { kind: 'owns_sites'; ownedSiteIds: string[] }
  | {
      kind: 'updated';
      removedSiteIds: string[];
      cancelledCommandCount: number;
    };

export async function removeSiteFromUser(
  ctx: RemoveSiteFromUserContext,
  input: RemoveSiteFromUserInput,
): Promise<RemoveSiteFromUserResult> {
  if (!input.uid) throw new Error('uid is required');
  if (!Array.isArray(input.siteIds) || input.siteIds.length === 0) {
    throw new Error('siteIds must be a non-empty array');
  }
  if (input.siteIds.length > MAX_SITES_PER_REQUEST) {
    return {
      kind: 'too_many',
      count: input.siteIds.length,
      max: MAX_SITES_PER_REQUEST,
    };
  }
  const malformed = input.siteIds.filter(
    (s) => typeof s !== 'string' || !SITE_ID_REGEX.test(s as string),
  );
  if (malformed.length > 0) {
    return { kind: 'invalid_format', malformed: malformed as string[] };
  }
  const validatedSiteIds = Array.from(new Set(input.siteIds));

  const db = input.db ?? getAdminDb();
  const userRef = db.collection('users').doc(input.uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    return { kind: 'not_found' };
  }

  // Refuse to strip membership from a site this user OWNS. Without this the
  // superadmin path can leave a site with no owner at all — unreachable through
  // the members endpoint, which returns 409 cannot_remove_owner for exactly this
  // case (app/api/sites/[siteId]/members/[uid]/route.ts). Ownership must be
  // transferred first. Reads are batched: one getAll over the named sites.
  const siteSnaps = await db.getAll(
    ...validatedSiteIds.map((id) => db.collection('sites').doc(id)),
  );
  const ownedSiteIds = siteSnaps
    .filter((snap) => snap.exists && snap.data()?.owner === input.uid)
    .map((snap) => snap.id);
  if (ownedSiteIds.length > 0) {
    return { kind: 'owns_sites', ownedSiteIds };
  }

  await userRef.update({
    sites: FieldValue.arrayRemove(...validatedSiteIds),
  });

  // Best-effort; errors don't block the response.
  let cancelledCommandCount = 0;
  const cancelFn = input.cancelCommands ?? cancelUserCommandsOnSites;
  try {
    cancelledCommandCount = await cancelFn(input.uid, validatedSiteIds);
  } catch (err) {
    logger.warn('removeSiteFromUser: command cancel sweep failed (non-fatal)', {
      context: 'actions/removeSiteFromUser',
      data: {
        uid: input.uid,
        siteIds: validatedSiteIds,
        err: err instanceof Error ? err.message : String(err),
      },
    });
  }

  emitMutation({
    kind: 'user_mutated',
    siteId: '',
    actor: ctx.auditActor,
    targetId: input.uid,
    attributes: {
      endpoint: ctx.endpoint ?? '',
      method: ctx.method ?? 'POST',
      verb: 'sites_removed',
      siteIds: validatedSiteIds,
      cancelledCommandCount,
    },
  });

  return {
    kind: 'updated',
    removedSiteIds: validatedSiteIds,
    cancelledCommandCount,
  };
}
