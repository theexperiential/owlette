/**
 * Canonical shared reads that belong to no single route wrapper. Privileged
 * authorization lives in `authorizedSiteHandler` / `authorizedPlatformHandler`.
 */

import { getAdminDb } from '@/lib/firebase-admin';

/**
 * Canonical site-membership read. Membership lives only on `users/{uid}.sites[]`
 * — there is no inverse `sites/{siteId}.members[]` (see
 * `dev/active/api-sprint/reference/membership-decision.md`) — so every caller
 * goes through here and firestore.rules stays the only other place pinned to the
 * field.
 *
 * `[]` when the user has no `sites` field or no doc at all. This is the explicit
 * assignment list, not the effective one: superadmin access comes from the role
 * check elsewhere.
 */
export async function getUserSiteIds(userId: string): Promise<string[]> {
  const db = getAdminDb();
  const userDoc = await db.collection('users').doc(userId).get();
  if (!userDoc.exists) return [];
  const data = userDoc.data();
  const sites = data?.sites;
  return Array.isArray(sites) ? sites.filter((s): s is string => typeof s === 'string') : [];
}
