/**
 * User soft-delete cascade helper.
 *
 * Performs the side-effects required when a superadmin deletes a user via
 * `DELETE /api/users/{uid}`:
 *
 *   1. Refuse if the user owns sites and no `successorUid` was supplied.
 *      Owned sites would otherwise be orphaned (unrouted membership reads,
 *      stuck rules checks). Caller passes a successor uid to transfer
 *      ownership atomically; this function verifies the successor exists
 *      and is at least admin-role before transferring.
 *   2. Revoke every api key the user owns. Sets `revokedAt` on each entry
 *      in both `users/{uid}/api_keys/*` and the matching top-level
 *      `api_keys/{keyHash}` lookup doc, so cached lookups stop succeeding.
 *   3. Cancel pending commands the user issued (best-effort, non-blocking
 *      — the cancellation runs as a background sweep so a slow command
 *      collection scan doesn't gate the response). The scan is bounded
 *      to the user's currently-assigned sites + owned sites.
 *   4. Set `users/{uid}.deletedAt`. The user doc is preserved (audit /
 *      historical reads still work) but excluded from default list reads.
 *   5. Revoke the user's Firebase Auth refresh tokens AND disable the
 *      Auth user record. The user can no longer mint new ID tokens, and
 *      any outstanding tokens are invalidated within the standard
 *      revocation window. We DON'T `deleteUser()` here — soft-delete
 *      semantics imply auditability, and keeping the Auth record around
 *      preserves the email→uid mapping for forensic queries. Hard-delete
 *      via the Auth admin SDK is reserved for the self-delete path.
 *
 * Returns a structured result so the route handler can emit the right
 * audit attributes + http response.
 */

import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';

export type UserDeleteOutcome =
  | { kind: 'already_deleted'; deletedAt: number }
  | { kind: 'not_found' }
  | {
      kind: 'orphan_sites';
      ownedSites: string[];
    }
  | {
      kind: 'successor_invalid';
      reason: 'not_found' | 'not_admin' | 'soft_deleted';
    }
  | {
      kind: 'deleted';
      deletedAt: number;
      revokedKeyIds: string[];
      transferredSites: string[];
      /**
       * Whether the Firebase Auth user was successfully revoked + disabled.
       * Best-effort: a transient Auth API failure does NOT roll back the
       * Firestore soft-delete (the rules already gate access via
       * `deletedAt`), but the flag surfaces to the caller for audit.
       */
      authDisabled: boolean;
    };

/**
 * Fetch the sites this user owns. Used by the route handler to surface the
 * orphan-sites guard before any mutation runs.
 */
export async function findOwnedSites(uid: string): Promise<string[]> {
  const db = getAdminDb();
  const ownedSnap = await db
    .collection('sites')
    .where('owner', '==', uid)
    .get();
  return ownedSnap.docs.map((d) => d.id);
}

interface CascadeOptions {
  /** Required when the user owns at least one site; rejected otherwise. */
  successorUid?: string | null;
}

export async function performUserDeleteCascade(
  uid: string,
  options: CascadeOptions = {},
): Promise<UserDeleteOutcome> {
  const db = getAdminDb();

  // 1. Read the user doc.
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    return { kind: 'not_found' };
  }
  const userData = userSnap.data() ?? {};

  // True-idempotent: a re-issued DELETE on an already-deleted user is a no-op.
  if (typeof userData.deletedAt === 'number') {
    return { kind: 'already_deleted', deletedAt: userData.deletedAt };
  }

  // 2. Owned-site check. Refuse without a successor.
  const ownedSites = await findOwnedSites(uid);
  const successorUid =
    typeof options.successorUid === 'string' && options.successorUid.length > 0
      ? options.successorUid
      : null;

  if (ownedSites.length > 0 && !successorUid) {
    return { kind: 'orphan_sites', ownedSites };
  }

  // 3. If a successor was supplied, verify it exists, isn't soft-deleted,
  //    and has at least 'admin' role (member-tier successors would inherit
  //    ownership but lack admin-surface access on the dashboard, breaking
  //    the site).
  if (successorUid) {
    const successorRef = db.collection('users').doc(successorUid);
    const successorSnap = await successorRef.get();
    if (!successorSnap.exists) {
      return { kind: 'successor_invalid', reason: 'not_found' };
    }
    const successorData = successorSnap.data() ?? {};
    if (typeof successorData.deletedAt === 'number') {
      return { kind: 'successor_invalid', reason: 'soft_deleted' };
    }
    const successorRole = successorData.role;
    if (successorRole !== 'admin' && successorRole !== 'superadmin') {
      return { kind: 'successor_invalid', reason: 'not_admin' };
    }
  }

  // 4. Transfer owned sites. Each site doc gets its `owner` field reset
  //    to the successor uid; the successor's `users.sites[]` is also
  //    extended via arrayUnion so they can read the site through the
  //    canonical membership model. The departing user's `sites[]` will
  //    be cleared in step 7 below (the whole field stays, but it doesn't
  //    matter — the user is soft-deleted and excluded from member reads).
  const transferredSites: string[] = [];
  if (successorUid && ownedSites.length > 0) {
    const { FieldValue } = await import('firebase-admin/firestore');
    for (const siteId of ownedSites) {
      try {
        await db.collection('sites').doc(siteId).update({
          owner: successorUid,
          ownerTransferredAt: Date.now(),
          ownerTransferredFrom: uid,
        });
        await db.collection('users').doc(successorUid).update({
          sites: FieldValue.arrayUnion(siteId),
        });
        transferredSites.push(siteId);
      } catch (err) {
        console.warn(
          `[userDeleteCascade] failed to transfer site ${siteId}: ${
            (err as Error).message
          }`,
        );
      }
    }
  }

  // 5. Revoke api keys: subcollection entries + top-level lookup docs.
  const revokedKeyIds: string[] = [];
  try {
    const keysSnap = await userRef.collection('api_keys').get();
    const now = Date.now();
    for (const keyDoc of keysSnap.docs) {
      const keyData = keyDoc.data() ?? {};
      // Skip already-revoked keys so we don't bump revokedAt unnecessarily.
      if (typeof keyData.revokedAt === 'number') continue;

      try {
        await keyDoc.ref.update({ revokedAt: now });
        revokedKeyIds.push(keyDoc.id);

        // Mirror revocation onto the top-level lookup doc so the auth path
        // (api_keys/{keyHash}) sees the revocation immediately. The lookup
        // doc id is the keyHash; we store it on the subcollection doc.
        const keyHash =
          typeof keyData.keyHash === 'string' ? keyData.keyHash : null;
        if (keyHash) {
          await db.collection('api_keys').doc(keyHash).update({
            revokedAt: now,
          }).catch(() => {
            // The lookup doc may not exist for very old keys; not fatal.
          });
        }
      } catch (err) {
        console.warn(
          `[userDeleteCascade] failed to revoke key ${keyDoc.id}: ${
            (err as Error).message
          }`,
        );
      }
    }
  } catch (err) {
    console.warn(
      `[userDeleteCascade] failed to enumerate api keys: ${
        (err as Error).message
      }`,
    );
  }

  // 6. Cancel pending commands the user issued. Best-effort, non-blocking
  //    on the response — fired-and-forgotten via setImmediate so the
  //    DELETE returns promptly even when the user has many sites/machines.
  //    The scope is bounded to the user's owned + assigned sites; cross-
  //    site commands (where a superadmin issued on a site they don't own)
  //    are not swept here, which is acceptable since the issuer record
  //    survives on the command doc for audit trails.
  const userSites = Array.isArray(userData.sites)
    ? (userData.sites as string[]).filter((s) => typeof s === 'string')
    : [];
  const sitesToScan = Array.from(new Set([...ownedSites, ...userSites]));
  if (sitesToScan.length > 0) {
    setImmediate(() => {
      void cancelUserCommands(uid, sitesToScan);
    });
  }

  // 7. Mark the user doc soft-deleted. Last write — earlier failures
  //    above are best-effort and shouldn't block the user from being
  //    flagged deleted (any orphaned api keys can be swept separately).
  const deletedAt = Date.now();
  await userRef.update({
    deletedAt,
    deletedBy: 'superadmin', // route handler doesn't pass actor here; auditLog has it
  });

  // 8. Revoke + disable the Firebase Auth user. The Firestore rules
  //    (`isNotDeletedUser`) gate session reads on `deletedAt`, but
  //    outstanding ID tokens remain technically valid until their natural
  //    expiry (~1h) unless we explicitly revoke. `disabled: true` blocks
  //    new sign-ins and short-circuits any custom-token mint flows.
  //    Best-effort: we don't roll back the Firestore soft-delete on Auth
  //    failure — the Firestore flag is already authoritative for
  //    authorization, and the Auth disable can be retried separately.
  let authDisabled = false;
  try {
    const adminAuth = getAdminAuth();
    try {
      await adminAuth.revokeRefreshTokens(uid);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code !== 'auth/user-not-found') {
        console.warn(
          `[userDeleteCascade] revokeRefreshTokens failed for ${uid}: ${
            (err as Error).message
          }`,
        );
      }
    }
    try {
      await adminAuth.updateUser(uid, { disabled: true });
      authDisabled = true;
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === 'auth/user-not-found') {
        // No Auth record (e.g. user was hard-deleted via self-delete path
        // earlier); treat as success — there's nothing to disable.
        authDisabled = true;
      } else {
        console.warn(
          `[userDeleteCascade] updateUser(disabled=true) failed for ${uid}: ${
            (err as Error).message
          }`,
        );
      }
    }
  } catch (err) {
    // getAdminAuth() can throw if env vars are missing (test mode without
    // mocks). Treat as soft failure — the Firestore soft-delete already
    // gates access via rules.
    console.warn(
      `[userDeleteCascade] admin auth unavailable for ${uid}: ${
        (err as Error).message
      }`,
    );
  }

  return {
    kind: 'deleted',
    deletedAt,
    revokedKeyIds,
    transferredSites,
    authDisabled,
  };
}

/**
 * Cancel pending commands the user issued, scoped to the given sites.
 * Each site is scanned for machines whose pending-commands subcollection
 * contains entries with `issuedBy === uid`. Cancellation is a best-effort
 * write of `cancelled: true` + `cancelledAt`.
 */
async function cancelUserCommands(uid: string, siteIds: string[]): Promise<void> {
  const db = getAdminDb();
  const now = Date.now();

  for (const siteId of siteIds) {
    try {
      const machinesSnap = await db
        .collection('sites')
        .doc(siteId)
        .collection('machines')
        .get();

      for (const machineDoc of machinesSnap.docs) {
        try {
          const cmdSnap = await machineDoc.ref
            .collection('commands')
            .doc('pending')
            .collection('items')
            .where('issuedBy', '==', uid)
            .get();
          for (const cmd of cmdSnap.docs) {
            await cmd.ref
              .update({ cancelled: true, cancelledAt: now })
              .catch(() => {});
          }
        } catch {
          // Some machines may not have the nested commands shape; tolerate.
        }
      }
    } catch (err) {
      console.warn(
        `[userDeleteCascade] command cancel sweep failed for site ${siteId}: ${
          (err as Error).message
        }`,
      );
    }
  }
}

/**
 * Cancel pending commands a user issued on a specific list of sites.
 *
 * Used by `POST /api/users/{uid}/remove-sites` — when an admin un-assigns
 * a user from a site, any commands they queued there should also be
 * voided. Returns the number of commands cancelled (best-effort metric;
 * partial failures are logged + counted as not-cancelled).
 */
export async function cancelUserCommandsOnSites(
  uid: string,
  siteIds: string[],
): Promise<number> {
  if (siteIds.length === 0) return 0;
  const db = getAdminDb();
  const now = Date.now();
  let cancelled = 0;

  for (const siteId of siteIds) {
    try {
      const machinesSnap = await db
        .collection('sites')
        .doc(siteId)
        .collection('machines')
        .get();

      for (const machineDoc of machinesSnap.docs) {
        try {
          const cmdSnap = await machineDoc.ref
            .collection('commands')
            .doc('pending')
            .collection('items')
            .where('issuedBy', '==', uid)
            .get();
          for (const cmd of cmdSnap.docs) {
            try {
              await cmd.ref.update({ cancelled: true, cancelledAt: now });
              cancelled += 1;
            } catch (err) {
              console.warn(
                `[cancelUserCommandsOnSites] failed for cmd ${cmd.id}: ${
                  (err as Error).message
                }`,
              );
            }
          }
        } catch {
          // Tolerate machines without the nested shape.
        }
      }
    } catch (err) {
      console.warn(
        `[cancelUserCommandsOnSites] sweep failed for site ${siteId}: ${
          (err as Error).message
        }`,
      );
    }
  }

  return cancelled;
}
