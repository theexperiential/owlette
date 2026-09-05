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

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';
import {
  generateCorrelationId,
  writeGlobalAuditEntryBlocking,
  type AuditActor,
} from '@/lib/auditLog.server';

export interface DeleteSiteInput {
  siteId: string;
  /** Inject a Firestore instance — tests pass a mock; production omits. */
  db?: Firestore;
}

export interface DeleteSiteContext {
  auditActor: string;
  endpoint?: string;
  method?: string;
  /**
   * The resolved actor, for the platform-sink audit row. Optional only so existing
   * callers and tests compile; when absent the row records an unattributed delete,
   * which is worse than useless in an investigation — pass it.
   */
  actor?: AuditActor;
  /**
   * The request's correlation id, so the surviving platform row joins to the
   * authorization decision that permitted it. A fresh id here would be
   * unjoinable to anything.
   */
  correlationId?: string;
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

  // Record the deletion in the PLATFORM sink BEFORE destroying anything. The site's
  // own audit_log is a subcollection of the document below, so a row written there
  // would be destroyed along with the evidence of who destroyed it. Blocking and
  // fail-closed: if the record cannot be written, the site is not deleted.
  if (ctx.actor) {
    const siteData = existing.data() ?? {};
    const owner = typeof siteData.owner === 'string' ? siteData.owner : null;
    // "Override" means a superadmin destroyed someone else's site — the case worth
    // finding in an investigation. A superadmin deleting their own site is an
    // ordinary owner delete and is not flagged as one.
    const superadminOverride =
      ctx.actor.type === 'user' &&
      ctx.actor.role === 'superadmin' &&
      owner !== ctx.actor.userId;

    await writeGlobalAuditEntryBlocking({
      correlationId: ctx.correlationId ?? generateCorrelationId(),
      actor: ctx.actor,
      capability: 'SITE_DELETE',
      target: { kind: 'site', id: input.siteId },
      outcome: 'allow',
      metadata: {
        endpoint: ctx.endpoint ?? '',
        method: ctx.method ?? 'DELETE',
        verb: 'deleted',
        siteName: typeof siteData.name === 'string' ? siteData.name : null,
        owner,
        superadminOverride,
      },
    }, db);
  }

  // Tombstone the id BEFORE freeing it. Site ids are caller-supplied slugs and
  // deletion does not clear `users/{uid}.sites[]` (see the TODO above), so without
  // this a later site reusing the slug silently inherits the previous site's
  // members — a cross-tenant grant nobody performed. Written first: a tombstone
  // with no delete is harmless, a delete with no tombstone is the bug.
  // Timestamp only. The deleting principal is already in the platform audit row
  // written just above, which is admin-gated; this document is client-readable
  // for the id-availability check and must carry nothing else.
  await db.collection('site_ids').doc(input.siteId).set({
    deletedAt: FieldValue.serverTimestamp(),
  });

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
