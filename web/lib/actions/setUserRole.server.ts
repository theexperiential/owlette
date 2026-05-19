/**
 * setUserRole action core (security-boundary-migration wave 3.9).
 *
 * Consolidates the bodies of the existing routes:
 *   - `POST /api/users/{uid}/promote` — accepts `role: 'admin' | 'superadmin'`
 *   - `POST /api/users/{uid}/demote`  — always sets `role: 'member'`
 *
 * Both routes preserve their public contracts; this core is the shared
 * implementation they delegate to. The transactional read-then-write keeps
 * concurrent role mutations safe (two simultaneous demotes can't both
 * observe "2 superadmins" and both succeed).
 *
 * **Last-superadmin guard.** When the current role is `superadmin` and the
 * target role is anything else, the transaction counts active (non-deleted)
 * superadmins; if dropping the target would put the count below
 * `MIN_SUPERADMINS` the result is `last_superadmin` and no write happens.
 *
 * Capability: `USER_ROLE_MANAGE` — superadmin-only via the platform handler
 * wrapper. Soft-deleted users are rejected (caller must restore first).
 */

import type { Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';

export type UserRole = 'member' | 'admin' | 'superadmin';

export const MIN_SUPERADMINS = 1;

export interface SetUserRoleInput {
  uid: string;
  role: UserRole;
  /** Inject a Firestore instance — tests pass a mock; production omits. */
  db?: Firestore;
}

export interface SetUserRoleContext {
  /** Audit actor string ("user:<uid>" or "apiKey:<keyId>"). */
  auditActor: string;
  /** Endpoint pathname for audit metadata (e.g. `/api/users/<uid>/promote`). */
  endpoint?: string;
  /** HTTP method for audit metadata (e.g. `POST`). */
  method?: string;
}

export type SetUserRoleResult =
  | { kind: 'not_found' }
  | { kind: 'deleted' }
  | { kind: 'noop'; previousRole: UserRole; newRole: UserRole }
  | { kind: 'updated'; previousRole: UserRole; newRole: UserRole }
  | { kind: 'last_superadmin'; activeSuperadmins: number };

const ROLES: ReadonlySet<UserRole> = new Set(['member', 'admin', 'superadmin']);

function asRole(value: unknown): UserRole {
  return typeof value === 'string' && ROLES.has(value as UserRole)
    ? (value as UserRole)
    : 'member';
}

export async function setUserRole(
  ctx: SetUserRoleContext,
  input: SetUserRoleInput,
): Promise<SetUserRoleResult> {
  if (!input.uid) throw new Error('uid is required');
  if (!ROLES.has(input.role)) {
    throw new Error(`role must be one of: ${[...ROLES].join(', ')}`);
  }

  const db = input.db ?? getAdminDb();
  const userRef = db.collection('users').doc(input.uid);
  const usersCol = db.collection('users');

  const result = await db.runTransaction<SetUserRoleResult>(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) {
      return { kind: 'not_found' };
    }
    const data = snap.data() ?? {};
    if (typeof data.deletedAt === 'number') {
      return { kind: 'deleted' };
    }
    const previousRole = asRole(data.role);

    if (previousRole === input.role) {
      return { kind: 'noop', previousRole, newRole: input.role };
    }

    // Last-superadmin protection: count active superadmins inside the
    // transaction so a concurrent demote can't race past us.
    if (previousRole === 'superadmin' && input.role !== 'superadmin') {
      const allSnap = await tx.get(usersCol);
      const activeSuperadmins = allSnap.docs.reduce((n, doc) => {
        const d = doc.data() ?? {};
        if (d.role !== 'superadmin') return n;
        if (typeof d.deletedAt === 'number') return n;
        return n + 1;
      }, 0);
      if (activeSuperadmins <= MIN_SUPERADMINS) {
        return { kind: 'last_superadmin', activeSuperadmins };
      }
    }

    tx.update(userRef, { role: input.role });
    return { kind: 'updated', previousRole, newRole: input.role };
  });

  if (result.kind === 'updated') {
    emitMutation({
      kind: 'user_mutated',
      siteId: '',
      actor: ctx.auditActor,
      targetId: input.uid,
      attributes: {
        endpoint: ctx.endpoint ?? '',
        method: ctx.method ?? 'POST',
        verb: input.role === 'member' ? 'demoted' : 'promoted',
        from: result.previousRole,
        to: result.newRole,
      },
    });
  }

  return result;
}
