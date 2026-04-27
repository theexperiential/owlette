/**
 * Shared API Helpers
 *
 * Provides canonical shared reads that do not belong to a specific route
 * wrapper. Privileged admin authorization now flows through
 * `authorizedSiteHandler` / `authorizedPlatformHandler`.
 */

import { getAdminDb } from '@/lib/firebase-admin';

/**
 * Canonical site-membership read.
 *
 * Owlette stores site membership exclusively on `users/{uid}.sites[]`. There
 * is no inverse `sites/{siteId}.members[]` collection - this was audited in
 * `dev/active/api-sprint/reference/membership-decision.md`. Every caller that
 * needs "what sites does this user belong to?" should go through this helper
 * so the read shape is identical across api-sprint waves and Firestore-rules
 * stays the only place that pins to the underlying field.
 *
 * Returns `[]` for users with no `sites` field (e.g. brand-new accounts) and
 * for users whose doc doesn't exist. Superadmins still have access to every
 * site via the role check elsewhere - this returns the explicit assignment
 * list, not the effective access list.
 */
export async function getUserSiteIds(userId: string): Promise<string[]> {
  const db = getAdminDb();
  const userDoc = await db.collection('users').doc(userId).get();
  if (!userDoc.exists) return [];
  const data = userDoc.data();
  const sites = data?.sites;
  return Array.isArray(sites) ? sites.filter((s): s is string => typeof s === 'string') : [];
}
