/**
 * Who may inherit a talon — the client mirror of
 * `hasCapability(successor, TALON_MANAGE, siteId)`, so the picker never offers
 * someone the reassign API will refuse. The server stays authoritative:
 * `reassignTalons` re-resolves every successor, because a browser list is a
 * suggestion, not a permission.
 *
 * Soft-deleted accounts are out (they are the failure mode this prevents);
 * members are out (TALON_MANAGE is an admin capability); admins qualify on
 * their assigned sites; superadmins everywhere.
 *
 * Omit `siteId` for the fleet-wide case (account deletion) — the per-site check
 * still runs server-side, and a candidate failing one site is reported, not hidden.
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
