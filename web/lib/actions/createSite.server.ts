/**
 * createSite action core (security-boundary-migration wave 3.9 - site CRUD).
 *
 * Replaces the client-side `setDoc` in `web/hooks/useFirestore.ts:createSite`.
 * The action validates the requested site id (`web/lib/validators.ts`),
 * refuses to overwrite an existing site, and writes the site doc with the
 * caller as `owner`.
 *
 * The site document and the creator's membership are written in one batch.
 * Ownership alone is not enough: the server honours it (firestore.rules
 * `isSiteOwner`, `GET /api/sites`, `apiAuth.server.ts`) but the client site
 * list resolves membership only — `useSites` in `web/hooks/useFirestore.ts`
 * iterates `users/{uid}.sites[]` and never queries by `owner`. A site written
 * without that membership entry is therefore invisible in-product to the very
 * user who just created it, with no self-service way to recover. That split
 * stranded every self-serve signup between 1756e5f (2026-03-20) and this fix.
 * Keep the two writes atomic so a site can never exist without its creator.
 *
 * Capability: `SITE_MEMBER_MANAGE` via the platform route wrapper. Site
 * creation has no existing site id to authorize against, so the route is
 * treated as a platform-level mutation.
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
  /** Inject a Firestore instance; tests pass a mock, production omits. */
  db?: Firestore;
  /** Inject a clock; tests pass a fixed value, production omits. */
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

  // `update` rather than `set(..., {merge:true})` on the user doc: the route
  // has already run `assertActiveUser`, so the document exists. If that
  // invariant ever breaks, failing the batch — and creating no site at all —
  // is the right outcome; a site nobody can see is the bug being fixed here.
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
