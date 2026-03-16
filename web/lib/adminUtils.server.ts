/**
 * Server-only admin utilities for Owlette operations.
 *
 * This file must only be imported in API routes (server-side).
 * NEVER import in client components.
 */

import { getAdminDb } from '@/lib/firebase-admin';

const isProduction =
  process.env.NODE_ENV === 'production' &&
  !process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN?.includes('dev');

const ADMIN_EMAIL = isProduction
  ? process.env.ADMIN_EMAIL_PROD
  : process.env.ADMIN_EMAIL_DEV;

/**
 * Look up all admin/user email addresses for a given site.
 *
 * Collects emails from:
 * 1. The site's owner field (userId → users/{userId}.email)
 * 2. All users whose `sites` array contains this siteId
 *
 * Falls back to the ADMIN_EMAIL env var if no users are found.
 *
 * @param siteId - Firestore site document ID
 * @returns Array of unique email addresses (may be empty if nothing configured)
 */
export async function getSiteAdminEmails(siteId: string): Promise<string[]> {
  const db = getAdminDb();
  const emails = new Set<string>();

  try {
    // 1. Get site document → find owner userId
    const siteDoc = await db.collection('sites').doc(siteId).get();
    const ownerId = siteDoc.data()?.owner as string | undefined;

    // 2. Query users where sites array contains this siteId
    const usersQuery = await db
      .collection('users')
      .where('sites', 'array-contains', siteId)
      .get();

    // 3. Extract emails from already-fetched query docs (no extra round-trips)
    const queriedIds = new Set<string>();
    for (const doc of usersQuery.docs) {
      queriedIds.add(doc.id);
      const email = doc.data()?.email as string | undefined;
      if (email) emails.add(email);
    }

    // Fetch owner separately only if not returned by the array-contains query
    if (ownerId && !queriedIds.has(ownerId)) {
      try {
        const ownerDoc = await db.collection('users').doc(ownerId).get();
        const email = ownerDoc.data()?.email as string | undefined;
        if (email) emails.add(email);
      } catch {
        // Skip if owner fetch fails
      }
    }
  } catch (error) {
    console.error('[adminUtils] Error fetching site admin emails:', error);
  }

  // Fallback to ADMIN_EMAIL env var if no site-specific emails found
  if (emails.size === 0 && ADMIN_EMAIL) {
    emails.add(ADMIN_EMAIL);
  }

  return Array.from(emails);
}
