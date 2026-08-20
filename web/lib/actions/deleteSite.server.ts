/**
 * deleteSite action core, replacing the client-side `deleteDoc` in
 * `useFirestore.ts:deleteSite`. Deliberately the SAME narrow delete: only the
 * top-level `sites/{siteId}` doc, leaving subcollections and user-membership
 * references intact, so callers migrate without behaviour drift. Adds an audit
 * event.
 *
 * TODO: site-cascade pass for subcollections + user references (the cloud-function
 * reconciler already cleans orphan deployment docs).
 */

import type { Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';

export interface DeleteSiteInput {
  siteId: string;
  /** Inject a Firestore instance — tests pass a mock; production omits. */
  db?: Firestore;
}

export interface DeleteSiteContext {
  auditActor: string;
  endpoint?: string;
  method?: string;
}

export type DeleteSiteResult =
  | { kind: 'not_found' }
  | { kind: 'deleted'; siteId: string };

export async function deleteSite(
  ctx: DeleteSiteContext,
  input: DeleteSiteInput,
): Promise<DeleteSiteResult> {
  if (!input.siteId) throw new Error('siteId is required');

  const db = input.db ?? getAdminDb();
  const siteRef = db.collection('sites').doc(input.siteId);
  const existing = await siteRef.get();
  if (!existing.exists) {
    return { kind: 'not_found' };
  }

  await siteRef.delete();

  emitMutation({
    kind: 'site_mutated',
    siteId: input.siteId,
    actor: ctx.auditActor,
    targetId: input.siteId,
    attributes: {
      endpoint: ctx.endpoint ?? '',
      method: ctx.method ?? 'DELETE',
      verb: 'deleted',
    },
  });

  return { kind: 'deleted', siteId: input.siteId };
}
