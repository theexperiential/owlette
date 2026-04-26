/**
 * DELETE /api/installer/{version}
 *
 * Soft-delete an installer version. The doc + storage object remain; only
 * the `deletedAt` field is set. Hard delete is a separate admin sweep.
 *
 * Refuses to drop the active version count below 2 — enforced inside a
 * Firestore transaction so concurrent deletes can't both see "3 active"
 * and both succeed. Returns 409 `min_versions_violated` if the delete
 * would breach the floor.
 *
 * Auth:
 *   - api key with `installer=*:admin` scope (superadmin-only at minting)
 *   - session / id-token from a superadmin user
 *
 * Idempotent by design — deleting an already-deleted version is a no-op
 * 200 (the second call returns the same shape, deletedAt unchanged).
 *
 * api-sprint wave 1 track 1B (installer-api).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problem,
  problemFromError,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';
import { applyAuthDeprecations, requirePlatformAuthAndScope } from '../../_shared';

const VERSION_REGEX = /^\d+\.\d+\.\d+$/;
const MIN_ACTIVE_VERSIONS = 2;

interface RouteParams {
  params: Promise<{ version: string }>;
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { version } = await params;
    if (!VERSION_REGEX.test(version)) {
      return problemValidation('version must match X.Y.Z', {
        'path.version': ['must be a semver string like "2.2.1"'],
      });
    }

    const auth = await requirePlatformAuthAndScope(request, 'installer', 'admin');
    if (!auth.ok) return auth.response;

    const db = getAdminDb();
    const versionsCol = db
      .collection('installer_metadata')
      .doc('data')
      .collection('versions');
    const targetRef = versionsCol.doc(version);

    const result = await db.runTransaction(async (tx) => {
      const targetSnap = await tx.get(targetRef);
      if (!targetSnap.exists) {
        return { kind: 'not_found' as const };
      }
      const targetData = targetSnap.data() ?? {};

      // Already soft-deleted: idempotent — return current state without
      // re-emitting an audit event or touching the doc.
      if (typeof targetData.deletedAt === 'number') {
        return {
          kind: 'already_deleted' as const,
          deletedAt: targetData.deletedAt as number,
        };
      }

      // Count active (non-deleted) versions inside the transaction so a
      // concurrent delete can't race past this check.
      const allSnap = await tx.get(versionsCol);
      const activeCount = allSnap.docs.reduce((n, doc) => {
        const d = doc.data();
        return typeof d.deletedAt === 'number' ? n : n + 1;
      }, 0);

      if (activeCount <= MIN_ACTIVE_VERSIONS) {
        return {
          kind: 'min_violated' as const,
          activeCount,
        };
      }

      const now = Date.now();
      tx.update(targetRef, {
        deletedAt: now,
        deletedBy: auth.userId,
      });
      return { kind: 'deleted' as const, deletedAt: now };
    });

    if (result.kind === 'not_found') {
      return problem({
        type: ProblemType.NotFound,
        title: 'version not found',
        status: 404,
        detail: `installer version ${version} does not exist`,
        instance: `/api/installer/${version}`,
      });
    }

    if (result.kind === 'min_violated') {
      return problem({
        type: ProblemType.Conflict,
        title: 'min versions violated',
        status: 409,
        detail: `cannot delete: only ${result.activeCount} active version(s) remain; floor is ${MIN_ACTIVE_VERSIONS}`,
        instance: `/api/installer/${version}`,
        code: 'min_versions_violated',
        minActiveVersions: MIN_ACTIVE_VERSIONS,
        currentActiveCount: result.activeCount,
      });
    }

    if (result.kind === 'deleted') {
      emitMutation({
        kind: 'installer_mutated',
        siteId: '',
        actor: auth.auth.keyContext
          ? `apiKey:${auth.auth.keyContext.keyId}`
          : `user:${auth.userId}`,
        targetId: version,
        attributes: {
          endpoint: `/api/installer/${version}`,
          method: 'DELETE',
          verb: 'soft_deleted',
        },
      });
    }

    return applyAuthDeprecations(
      NextResponse.json({
        version,
        deletedAt: result.deletedAt,
        alreadyDeleted: result.kind === 'already_deleted',
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'installer/[version]:DELETE');
  }
}
