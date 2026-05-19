/**
 * deleteSite action core (security-boundary-migration wave 3.9 — site CRUD).
 *
 * Replaces the client-side `deleteDoc` in `web/hooks/useFirestore.ts:deleteSite`.
 * The legacy hook deleted ONLY the top-level `sites/{siteId}` doc and
 * left subcollections (machines, deployments, audit_log, etc.) plus
 * user-membership references intact, with a `// TODO: Clean up user
 * references` comment. We preserve that exact behavior here — the
 * action core mirrors the hook's narrow delete + emits an audit event,
 * so callers can migrate without behaviour drift.
 *
 * Subcollection cleanup remains a follow-up (deferred to a dedicated site-
 * cascade pass; the cloud-function deployment reconciler already cleans
 * orphan deployment docs). Documented in the hook's TODO.
 *
 * Capability: site-scoped — wrapper enforces caller can administer the
 * target site.
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
