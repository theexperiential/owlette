/**
 * Soft-deletes an installer version: stamps `deletedAt`/`deletedBy`, leaves the
 * doc. Hard delete (storage + doc) is a separate admin sweep.
 *
 * Refuses to take the active count below MIN_ACTIVE_VERSIONS, checked inside
 * the transaction so two concurrent deletes can't both see "3 active".
 * Idempotent — re-deleting returns the existing `deletedAt`, no new audit event.
 *
 * Firestore paths are platform-level, NOT site-scoped.
 */

import { getAdminDb } from '@/lib/firebase-admin';
import type { UserActor } from '@/lib/capabilities';
import { InstallerValidationError, VERSION_REGEX } from './uploadInstaller.server';

export const MIN_ACTIVE_VERSIONS = 2;

export interface DeleteInstallerContext {
  actor: UserActor;
  version: string;
}

export type DeleteInstallerResult =
  | { kind: 'deleted'; version: string; deletedAt: number; alreadyDeleted: false }
  | { kind: 'already_deleted'; version: string; deletedAt: number; alreadyDeleted: true };

export class InstallerVersionNotFoundError extends Error {
  version: string;
  constructor(version: string) {
    super(`installer version not found: ${version}`);
    this.name = 'InstallerVersionNotFoundError';
    this.version = version;
  }
}

export class InstallerMinVersionsViolatedError extends Error {
  activeCount: number;
  minActiveVersions: number;
  constructor(activeCount: number) {
    super(
      `cannot delete: only ${activeCount} active version(s) remain; floor is ${MIN_ACTIVE_VERSIONS}`,
    );
    this.name = 'InstallerMinVersionsViolatedError';
    this.activeCount = activeCount;
    this.minActiveVersions = MIN_ACTIVE_VERSIONS;
  }
}

export async function deleteInstaller(
  ctx: DeleteInstallerContext,
): Promise<DeleteInstallerResult> {
  if (typeof ctx.version !== 'string' || !VERSION_REGEX.test(ctx.version)) {
    throw new InstallerValidationError(
      'version',
      'version must be a semver string like "2.2.1"',
    );
  }

  const db = getAdminDb();
  const versionsCol = db
    .collection('installer_metadata')
    .doc('data')
    .collection('versions');
  const targetRef = versionsCol.doc(ctx.version);

  const result = await db.runTransaction(async (tx) => {
    const targetSnap = await tx.get(targetRef);
    if (!targetSnap.exists) {
      return { kind: 'not_found' as const };
    }
    const targetData = targetSnap.data() ?? {};

    if (typeof targetData.deletedAt === 'number') {
      return {
        kind: 'already_deleted' as const,
        deletedAt: targetData.deletedAt as number,
      };
    }

    // Inside the txn so racing deletes can't both squeeze past the floor.
    const allSnap = await tx.get(versionsCol);
    const activeCount = allSnap.docs.reduce((n, doc) => {
      const d = doc.data();
      return typeof d.deletedAt === 'number' ? n : n + 1;
    }, 0);

    if (activeCount <= MIN_ACTIVE_VERSIONS) {
      return { kind: 'min_violated' as const, activeCount };
    }

    const now = Date.now();
    tx.update(targetRef, {
      deletedAt: now,
      deletedBy: ctx.actor.userId,
    });
    return { kind: 'deleted' as const, deletedAt: now };
  });

  if (result.kind === 'not_found') {
    throw new InstallerVersionNotFoundError(ctx.version);
  }
  if (result.kind === 'min_violated') {
    throw new InstallerMinVersionsViolatedError(result.activeCount);
  }
  if (result.kind === 'already_deleted') {
    return {
      kind: 'already_deleted',
      version: ctx.version,
      deletedAt: result.deletedAt,
      alreadyDeleted: true,
    };
  }
  return {
    kind: 'deleted',
    version: ctx.version,
    deletedAt: result.deletedAt,
    alreadyDeleted: false,
  };
}
