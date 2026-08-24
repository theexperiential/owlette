/**
 * createSite action core. Replaces the client-side `setDoc` in
 * `useFirestore.ts:createSite`: validates the site id, refuses to overwrite an
 * existing site, and writes the site doc with the caller as `owner`.
 *
 * The site doc and the creator's membership MUST stay in one batch. Ownership
 * alone isn't enough — the server honours it, but the client site list resolves
 * membership only (`useSites` iterates `users/{uid}.sites[]` and never queries
 * by `owner`). A site without the membership entry is invisible to the user who
 * created it, with no self-service recovery; that stranded every self-serve
 * signup between 1756e5f (2026-03-20) and this fix.
 *
 * Capability `SITE_MEMBER_MANAGE` via the platform route wrapper — there is no
 * existing site id to authorize against, so this is a platform-level mutation.
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';
import { validateSiteId } from '@/lib/validators';

const NAME_MAX_LENGTH = 200;

export interface CreateSiteInput {
  siteId: string;
  name: string;
  ownerUid: string;
  timezone?: string;
  /** Tests pass a mock; production omits. */
  db?: Firestore;
  /** Tests pass a fixed clock; production omits. */
  now?: () => Date;
}

export interface CreateSiteContext {
  auditActor: string;
  endpoint?: string;
  method?: string;
}

export type CreateSiteResult =
  | { kind: 'invalid_site_id'; reason: string }
  | { kind: 'invalid_name'; reason: string }
  | { kind: 'already_exists' }
  | {
      kind: 'created';
      siteId: string;
      name: string;
      timezone: string;
      owner: string;
      createdAt: number;
    };

export async function createSite(
  ctx: CreateSiteContext,
  input: CreateSiteInput,
): Promise<CreateSiteResult> {
  if (!input.ownerUid) throw new Error('ownerUid is required');

  const idCheck = validateSiteId(input.siteId);
  if (!idCheck.isValid) {
    return { kind: 'invalid_site_id', reason: idCheck.error ?? 'invalid site id' };
  }

  const trimmedName = typeof input.name === 'string' ? input.name.trim() : '';
  if (trimmedName.length === 0) {
    return { kind: 'invalid_name', reason: 'site name is required' };
  }
  if (trimmedName.length > NAME_MAX_LENGTH) {
    return {
      kind: 'invalid_name',
      reason: `site name must be ${NAME_MAX_LENGTH} characters or fewer`,
    };
  }

  const timezone =
    typeof input.timezone === 'string' && input.timezone.length > 0
      ? input.timezone
      : 'UTC';

  const db = input.db ?? getAdminDb();
  const siteRef = db.collection('sites').doc(input.siteId);

  const existing = await siteRef.get();
  if (existing.exists) {
    return { kind: 'already_exists' };
  }

  const nowDate = (input.now ?? (() => new Date()))();

  // `update`, not `set(..., {merge:true})`: the route already ran
  // `assertActiveUser`, so the doc exists. If that invariant breaks, failing the
  // whole batch is correct — an invisible site is exactly the bug fixed here.
  const batch = db.batch();
  batch.set(siteRef, {
    name: trimmedName,
    createdAt: nowDate,
    owner: input.ownerUid,
    timezone,
  });
  batch.update(db.collection('users').doc(input.ownerUid), {
    sites: FieldValue.arrayUnion(input.siteId),
  });
  await batch.commit();

  emitMutation({
    kind: 'site_mutated',
    siteId: input.siteId,
    actor: ctx.auditActor,
    targetId: input.siteId,
    attributes: {
      endpoint: ctx.endpoint ?? '',
      method: ctx.method ?? 'POST',
      verb: 'created',
      owner: input.ownerUid,
      timezone,
    },
  });

  return {
    kind: 'created',
    siteId: input.siteId,
    name: trimmedName,
    timezone,
    owner: input.ownerUid,
    createdAt: nowDate.getTime(),
  };
}
