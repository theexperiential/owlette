/**
 * Server-side replacement for the client `updateDoc` in
 * `useFirestore.ts:updateSite`. Whitelisted fields only (`name`, `timezone`,
 * `timeFormat`); an empty payload yields `kind: 'no_changes'` so the route can
 * 200 without writing. Validation matches the legacy hook: non-empty name and
 * the `timeFormat` union, timezone passed through as given.
 *
 * Capability: site-scoped `SITE_MEMBER_MANAGE`.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';

const NAME_MAX_LENGTH = 200;
const ALLOWED_TIME_FORMATS = new Set<'12h' | '24h'>(['12h', '24h']);

export interface UpdateSiteInput {
  siteId: string;
  name?: string;
  timezone?: string;
  timeFormat?: '12h' | '24h';
  /** Inject a Firestore instance; tests pass a mock, production omits. */
  db?: Firestore;
}

export interface UpdateSiteContext {
  auditActor: string;
  endpoint?: string;
  method?: string;
}

export type UpdateSiteResult =
  | { kind: 'not_found' }
  | { kind: 'invalid_name'; reason: string }
  | { kind: 'invalid_timezone'; reason: string }
  | { kind: 'invalid_time_format'; reason: string }
  | { kind: 'no_changes' }
  | { kind: 'updated'; updated: Record<string, string> };

export async function updateSite(
  ctx: UpdateSiteContext,
  input: UpdateSiteInput,
): Promise<UpdateSiteResult> {
  if (!input.siteId) throw new Error('siteId is required');

  const updates: Record<string, string> = {};

  if (input.name !== undefined) {
    if (typeof input.name !== 'string') {
      return { kind: 'invalid_name', reason: 'name must be a string' };
    }
    const trimmed = input.name.trim();
    if (trimmed.length === 0) {
      return { kind: 'invalid_name', reason: 'site name cannot be empty' };
    }
    if (trimmed.length > NAME_MAX_LENGTH) {
      return {
        kind: 'invalid_name',
        reason: `site name must be ${NAME_MAX_LENGTH} characters or fewer`,
      };
    }
    updates.name = trimmed;
  }

  if (input.timezone !== undefined) {
    if (typeof input.timezone !== 'string') {
      return { kind: 'invalid_timezone', reason: 'timezone must be a string' };
    }
    updates.timezone = input.timezone;
  }

  if (input.timeFormat !== undefined) {
    if (!ALLOWED_TIME_FORMATS.has(input.timeFormat)) {
      return {
        kind: 'invalid_time_format',
        reason: `timeFormat must be one of: ${[...ALLOWED_TIME_FORMATS].join(', ')}`,
      };
    }
    updates.timeFormat = input.timeFormat;
  }

  if (Object.keys(updates).length === 0) {
    return { kind: 'no_changes' };
  }

  const db = input.db ?? getAdminDb();
  const siteRef = db.collection('sites').doc(input.siteId);
  const existing = await siteRef.get();
  if (!existing.exists) {
    return { kind: 'not_found' };
  }

  await siteRef.update(updates);

  emitMutation({
    kind: 'site_mutated',
    siteId: input.siteId,
    actor: ctx.auditActor,
    targetId: input.siteId,
    attributes: {
      endpoint: ctx.endpoint ?? '',
      method: ctx.method ?? 'PATCH',
      verb: 'updated',
      fields: Object.keys(updates),
    },
  });

  return { kind: 'updated', updated: updates };
}
