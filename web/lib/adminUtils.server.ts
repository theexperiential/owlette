/**
 * Server-only admin utilities for Owlette operations.
 *
 * This file must only be imported in API routes (server-side).
 * NEVER import in client components.
 */

import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';

export interface SiteRecipient {
  userId: string;
  email: string;
  ccEmails: string[];
  mutedMachines: string[];
}

const isProduction =
  process.env.NODE_ENV === 'production' &&
  !process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN?.includes('dev');

const ADMIN_EMAIL = isProduction
  ? process.env.ADMIN_EMAIL_PROD
  : process.env.ADMIN_EMAIL_DEV;

/**
 * Human-readable label for a site, for use in alert emails: `"name (siteId)"`
 * when the site has a name, otherwise just the id. So recipients see
 * `TEC (default_site)` instead of the unreadable raw document id. Falls back to
 * the bare id on any lookup failure.
 */
export async function getSiteLabel(siteId: string): Promise<string> {
  try {
    const siteDoc = await getAdminDb().collection('sites').doc(siteId).get();
    const name = (siteDoc.data()?.name as string | undefined)?.trim();
    return name && name !== siteId ? `${name} (${siteId})` : siteId;
  } catch {
    return siteId;
  }
}

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
 * Optionally filters by a specific alert preference field.
 */
export async function getSiteAlertRecipients(
  siteId: string,
  filterPreference?: 'healthAlerts' | 'processAlerts' | 'thresholdAlerts' | 'cortexAlerts' | 'displayAlerts'
): Promise<SiteRecipient[]> {
  const db = getAdminDb();
  const recipients: SiteRecipient[] = [];
  const seenIds = new Set<string>();
  // A thrown error during enumeration is NOT the same as "genuinely no
  // recipients". On failure we must fall open (deliver) rather than apply the
  // admin's mutes below, or a transient Firestore error plus an admin mute
  // could silently drop an alert that real recipients should have received.
  let enumerationFailed = false;
  // Whether the site has at least one real, alertable user (a member or the
  // owner, with an email and not deleted) — even if they opted out of THIS
  // alert type. When true, an empty recipient set means "everyone opted out",
  // a deliberate choice we must respect — NOT an orphan site needing the
  // ADMIN_EMAIL safety net. Only a site with zero such users triggers fallback.
  let siteHasUsers = false;

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
      if (typeof data?.deletedAt === 'number') continue;
      const email = data?.email as string | undefined;
      if (!email) continue;
      siteHasUsers = true;
      if (filterPreference && data?.preferences?.[filterPreference] === false) continue;
      recipients.push({ userId: doc.id, email, ccEmails: data?.preferences?.alertCcEmails || [], mutedMachines: data?.preferences?.mutedMachines || [] });
    }

    if (ownerId && !seenIds.has(ownerId)) {
      try {
        const ownerDoc = await db.collection('users').doc(ownerId).get();
        const data = ownerDoc.data();
        if (typeof data?.deletedAt !== 'number') {
          const email = data?.email as string | undefined;
          if (email) {
            siteHasUsers = true;
            if (!(filterPreference && data?.preferences?.[filterPreference] === false)) {
              recipients.push({ userId: ownerId, email, ccEmails: data?.preferences?.alertCcEmails || [], mutedMachines: data?.preferences?.mutedMachines || [] });
            }
          }
        }
      } catch {
        // Owner lookup failed — treat as an enumeration failure so the empty
        // recipient set below is recognized as untrustworthy and the fallback
        // falls open (delivers) instead of applying the admin's mutes.
        enumerationFailed = true;
      }
    }
  } catch (error) {
    enumerationFailed = true;
    console.error('[adminUtils] Error fetching site alert recipients:', error);
  }

  // Fallback to ADMIN_EMAIL env var ONLY for a genuinely orphan site — one with
  // no real alertable users at all (no member/owner with an email), or when
  // enumeration threw (untrustworthy "empty" — fail open to deliver). If the
  // site HAS users who simply opted out of this alert type (siteHasUsers), that
  // empty set is their deliberate choice and must be respected — firing the
  // fallback would override the opt-out and spam the admin.
  //
  // When the fallback does fire, load the admin user's own muted-machines so a
  // mute is honored even on this synthetic recipient (an empty list here would
  // silently defeat the per-recipient mute guard in every alert sender). Fails
  // open to delivery (empty mutes) when ADMIN_EMAIL maps to no Auth user (e.g. a
  // distribution list) or Auth is unreachable, so a misconfigured admin email
  // never drops alerts.
  if (recipients.length === 0 && ADMIN_EMAIL && (enumerationFailed || !siteHasUsers)) {
    let mutedMachines: string[] = [];
    // Only honor the admin's mutes when the recipient set is GENUINELY empty.
    // If enumeration threw, "empty" is untrustworthy — fall open with no mutes
    // so a real recipient's alert is delivered rather than silently suppressed.
    if (!enumerationFailed) {
      try {
        const adminUser = await getAdminAuth().getUserByEmail(ADMIN_EMAIL);
        const adminDoc = await db.collection('users').doc(adminUser.uid).get();
        const adminData = adminDoc.data();
        if (adminData && typeof adminData.deletedAt !== 'number') {
          mutedMachines = adminData.preferences?.mutedMachines || [];
        }
      } catch {
        // ADMIN_EMAIL has no Auth user or Auth is unreachable — keep empty mutes
        // so alerts still deliver to the configured fallback address.
      }
    }
    recipients.push({ userId: 'fallback', email: ADMIN_EMAIL, ccEmails: [], mutedMachines });
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
      if (typeof data?.deletedAt === 'number') continue;
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
        if (typeof data?.deletedAt !== 'number') {
          const email = data?.email as string | undefined;
          if (email && data?.preferences?.[filterPreference] !== false) {
            toEmails.add(email);
            const userCc = data?.preferences?.alertCcEmails as string[] | undefined;
            if (userCc) userCc.forEach(cc => ccEmails.add(cc));
          }
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

/**
 * Resolve a machine's local timezone for display in alert emails.
 *
 * Returns the IANA name (e.g. "America/New_York") from `machine_timezone_iana`,
 * which is the only format `Intl.DateTimeFormat({ timeZone })` and Python's
 * `zoneinfo.ZoneInfo()` accept. The sibling `machine_timezone` field holds the
 * Windows registry name (e.g. "Eastern Standard Time") and MUST NOT be used —
 * `Intl` throws a RangeError on it (see emailTimestamp). Agents < 2.6.1 only
 * reported the Windows name, so this returns undefined for them; callers fall
 * back to UTC, and the field appears once the agent is upgraded.
 */
export async function getMachineTimezone(siteId: string, machineId: string): Promise<string | undefined> {
  try {
    const db = getAdminDb();
    const machineDoc = await db.collection('sites').doc(siteId).collection('machines').doc(machineId).get();
    return machineDoc.data()?.machine_timezone_iana as string | undefined;
  } catch {
    return undefined;
  }
}
