/**
 * Server-only admin utilities for Owlette operations.
 *
 * This file must only be imported in API routes (server-side).
 * NEVER import in client components.
 */

import { getAdminDb } from '@/lib/firebase-admin';

export interface SiteRecipient {
  userId: string;
  email: string;
  ccEmails: string[];
}

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
 * @param filterByHealthAlerts - If true, only return users who have healthAlerts enabled (default: false)
 * @returns Array of unique email addresses (may be empty if nothing configured)
 */
export async function getSiteAdminEmails(siteId: string, filterByHealthAlerts = false): Promise<string[]> {
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

    // 3. Extract emails, optionally filtering by healthAlerts preference
    const queriedIds = new Set<string>();
    for (const doc of usersQuery.docs) {
      queriedIds.add(doc.id);
      const data = doc.data();
      const email = data?.email as string | undefined;
      if (!email) continue;

      if (filterByHealthAlerts) {
        // healthAlerts defaults to true (opt-out model)
        const healthAlerts = data?.preferences?.healthAlerts;
        if (healthAlerts === false) continue;
      }

      emails.add(email);
    }

    // Fetch owner separately only if not returned by the array-contains query
    if (ownerId && !queriedIds.has(ownerId)) {
      try {
        const ownerDoc = await db.collection('users').doc(ownerId).get();
        const data = ownerDoc.data();
        const email = data?.email as string | undefined;
        if (email) {
          if (filterByHealthAlerts) {
            const healthAlerts = data?.preferences?.healthAlerts;
            if (healthAlerts !== false) emails.add(email);
          } else {
            emails.add(email);
          }
        }
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

/**
 * Look up site admin emails filtered by processAlerts preference.
 * Returns emails for users who have processAlerts !== false (default: true).
 */
export async function getSiteProcessAlertEmails(siteId: string): Promise<string[]> {
  const db = getAdminDb();
  const emails = new Set<string>();

  try {
    const siteDoc = await db.collection('sites').doc(siteId).get();
    const ownerId = siteDoc.data()?.owner as string | undefined;

    const usersQuery = await db
      .collection('users')
      .where('sites', 'array-contains', siteId)
      .get();

    const queriedIds = new Set<string>();
    for (const doc of usersQuery.docs) {
      queriedIds.add(doc.id);
      const data = doc.data();
      const email = data?.email as string | undefined;
      if (!email) continue;
      // processAlerts defaults to true (opt-out model)
      if (data?.preferences?.processAlerts === false) continue;
      emails.add(email);
    }

    if (ownerId && !queriedIds.has(ownerId)) {
      try {
        const ownerDoc = await db.collection('users').doc(ownerId).get();
        const data = ownerDoc.data();
        const email = data?.email as string | undefined;
        if (email && data?.preferences?.processAlerts !== false) {
          emails.add(email);
        }
      } catch {
        // Skip if owner fetch fails
      }
    }
  } catch (error) {
    console.error('[adminUtils] Error fetching site process alert emails:', error);
  }

  if (emails.size === 0) {
    const ADMIN_EMAIL_FALLBACK = isProduction
      ? process.env.ADMIN_EMAIL_PROD
      : process.env.ADMIN_EMAIL_DEV;
    if (ADMIN_EMAIL_FALLBACK) {
      emails.add(ADMIN_EMAIL_FALLBACK);
    }
  }

  return Array.from(emails);
}

/**
 * Look up site recipients with userId + email for personalized emails (e.g., unsubscribe links).
 * Filters by healthAlerts preference by default.
 */
export async function getSiteAlertRecipients(siteId: string): Promise<SiteRecipient[]> {
  const db = getAdminDb();
  const recipients: SiteRecipient[] = [];
  const seenIds = new Set<string>();

  try {
    const siteDoc = await db.collection('sites').doc(siteId).get();
    const ownerId = siteDoc.data()?.owner as string | undefined;

    const usersQuery = await db
      .collection('users')
      .where('sites', 'array-contains', siteId)
      .get();

    for (const doc of usersQuery.docs) {
      seenIds.add(doc.id);
      const data = doc.data();
      const email = data?.email as string | undefined;
      if (!email) continue;
      if (data?.preferences?.healthAlerts === false) continue;
      recipients.push({ userId: doc.id, email, ccEmails: data?.preferences?.alertCcEmails || [] });
    }

    if (ownerId && !seenIds.has(ownerId)) {
      try {
        const ownerDoc = await db.collection('users').doc(ownerId).get();
        const data = ownerDoc.data();
        const email = data?.email as string | undefined;
        if (email && data?.preferences?.healthAlerts !== false) {
          recipients.push({ userId: ownerId, email, ccEmails: data?.preferences?.alertCcEmails || [] });
        }
      } catch {
        // Skip
      }
    }
  } catch (error) {
    console.error('[adminUtils] Error fetching site alert recipients:', error);
  }

  // Fallback to ADMIN_EMAIL env var if no recipients found
  if (recipients.length === 0 && ADMIN_EMAIL) {
    recipients.push({ userId: 'fallback', email: ADMIN_EMAIL, ccEmails: [] });
  }

  return recipients;
}

/**
 * Look up site alert emails with CC addresses, filtered by a specific alert preference.
 * Returns deduplicated `to` and `cc` arrays ready for Resend.
 */
export async function getSiteAlertEmailsWithCc(
  siteId: string,
  filterPreference: 'healthAlerts' | 'processAlerts'
): Promise<{ to: string[]; cc: string[] }> {
  const db = getAdminDb();
  const toEmails = new Set<string>();
  const ccEmails = new Set<string>();

  try {
    const siteDoc = await db.collection('sites').doc(siteId).get();
    const ownerId = siteDoc.data()?.owner as string | undefined;

    const usersQuery = await db
      .collection('users')
      .where('sites', 'array-contains', siteId)
      .get();

    const queriedIds = new Set<string>();
    for (const doc of usersQuery.docs) {
      queriedIds.add(doc.id);
      const data = doc.data();
      const email = data?.email as string | undefined;
      if (!email) continue;
      if (data?.preferences?.[filterPreference] === false) continue;
      toEmails.add(email);
      const userCc = data?.preferences?.alertCcEmails as string[] | undefined;
      if (userCc) userCc.forEach(cc => ccEmails.add(cc));
    }

    if (ownerId && !queriedIds.has(ownerId)) {
      try {
        const ownerDoc = await db.collection('users').doc(ownerId).get();
        const data = ownerDoc.data();
        const email = data?.email as string | undefined;
        if (email && data?.preferences?.[filterPreference] !== false) {
          toEmails.add(email);
          const userCc = data?.preferences?.alertCcEmails as string[] | undefined;
          if (userCc) userCc.forEach(cc => ccEmails.add(cc));
        }
      } catch {
        // Skip if owner fetch fails
      }
    }
  } catch (error) {
    console.error('[adminUtils] Error fetching site alert emails with CC:', error);
  }

  if (toEmails.size === 0 && ADMIN_EMAIL) {
    toEmails.add(ADMIN_EMAIL);
  }

  // Remove CC addresses that are already primary recipients
  return {
    to: Array.from(toEmails),
    cc: Array.from(ccEmails).filter(cc => !toEmails.has(cc)),
  };
}
