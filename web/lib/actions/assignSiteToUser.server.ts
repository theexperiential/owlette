/**
 * assignSiteToUser action core (security-boundary-migration wave 3.9).
 *
 * Adds one or more siteIds to `users/{uid}.sites[]` via `arrayUnion`
 * (idempotent at the field level — duplicates are de-duped by Firestore).
 * Each site id is validated against `sites/{id}` existence first; if any
 * are unknown, the entire request is rejected with `unknown_sites` and no
 * sites are added (partial assignments are confusing for callers).
 *
 * Capability: `SITE_MEMBER_MANAGE` — handler-side authorization decides
 * whether the caller is allowed to invoke this. The action core only
 * knows about validation + the firestore write.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';

export const MAX_SITES_PER_REQUEST = 100;
const SITE_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

export interface AssignSiteToUserInput {
  uid: string;
  siteIds: string[];
  /** Inject a Firestore instance — tests pass a mock; production omits. */
  db?: Firestore;
}

export interface AssignSiteToUserContext {
  /** Audit actor string ("user:<uid>" or "apiKey:<keyId>"). */
  auditActor: string;
  endpoint?: string;
  method?: string;
}

export type AssignSiteToUserResult =
  | { kind: 'not_found' }
  | { kind: 'deleted' }
  | { kind: 'invalid_format'; malformed: string[] }
  | { kind: 'too_many'; count: number; max: number }
  | { kind: 'unknown_sites'; unknownSites: string[] }
  | { kind: 'updated'; assignedSiteIds: string[] };

export async function assignSiteToUser(
  ctx: AssignSiteToUserContext,
  input: AssignSiteToUserInput,
): Promise<AssignSiteToUserResult> {
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
  const userData = userSnap.data() ?? {};
  if (typeof userData.deletedAt === 'number') {
    return { kind: 'deleted' };
  }

  // Validate every site exists. Reject the whole batch if any are unknown.
  const unknownSites: string[] = [];
  await Promise.all(
    validatedSiteIds.map(async (siteId) => {
      const snap = await db.collection('sites').doc(siteId).get();
      if (!snap.exists) unknownSites.push(siteId);
    }),
  );
  if (unknownSites.length > 0) {
    return { kind: 'unknown_sites', unknownSites };
  }

  await userRef.update({
    sites: FieldValue.arrayUnion(...validatedSiteIds),
  });

  emitMutation({
    kind: 'user_mutated',
    siteId: '',
    actor: ctx.auditActor,
    targetId: input.uid,
    attributes: {
      endpoint: ctx.endpoint ?? '',
      method: ctx.method ?? 'POST',
      verb: 'sites_assigned',
      siteIds: validatedSiteIds,
    },
  });

  return { kind: 'updated', assignedSiteIds: validatedSiteIds };
}
