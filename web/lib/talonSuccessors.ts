/**
 * Who may inherit a talon.
 *
 * This is the client-side mirror of the server's rule, so the picker never
 * offers a successor the reassign API is going to refuse. The server remains
 * authoritative — `reassignTalons` re-resolves the successor against
 * `users/{uid}` and the capability matrix on every call, because a list
 * rendered in a browser is a suggestion, not a permission.
 *
 * The rule itself is `hasCapability(successor, TALON_MANAGE, siteId)` restated
 * over the shape the users table already has loaded:
 *
 *   - soft-deleted accounts are out — they are exactly the failure mode this
 *     feature exists to prevent, so handing them a talon would be circular;
 *   - members are out — TALON_MANAGE is an admin capability, so a member could
 *     not have authored the talon in the first place;
 *   - an admin qualifies on the sites they are assigned to;
 *   - a superadmin qualifies everywhere (TALON_MANAGE is site-scoped, and
 *     `hasCapability` short-circuits site scoping for superadmins).
 *
 * Omit `siteId` for the fleet-wide case (account deletion): the per-site check
 * still happens server-side, once per site, and a candidate who fails on one
 * site is reported rather than hidden.
 */

export interface TalonSuccessorUser {
  uid: string;
  email?: string;
  displayName?: string;
  role?: string;
  sites?: string[];
  deletedAt?: number;
}

export interface TalonSuccessorOption {
  uid: string;
  label: string;
}

export interface EligibleSuccessorOptions {
  /** Restrict to admins who can author on this site. Omit for fleet-wide. */
  siteId?: string;
  /** The departing user — never a candidate to inherit from themselves. */
  excludeUid?: string;
}

function label(user: TalonSuccessorUser): string {
  return user.email || user.displayName || user.uid;
}

export function eligibleTalonSuccessors(
  users: readonly TalonSuccessorUser[],
  { siteId, excludeUid }: EligibleSuccessorOptions = {},
): TalonSuccessorOption[] {
  return users
    .filter((user) => {
      if (user.uid === excludeUid) return false;
      if (user.deletedAt != null) return false;
      if (user.role === 'superadmin') return true;
      if (user.role !== 'admin') return false;
      if (!siteId) return true;
      return Array.isArray(user.sites) && user.sites.includes(siteId);
    })
    .map((user) => ({ uid: user.uid, label: label(user) }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}
