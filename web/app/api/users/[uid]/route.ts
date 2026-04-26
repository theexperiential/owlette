/**
 * GET    /api/users/{uid}     — user detail incl. site assignments
 * DELETE /api/users/{uid}     — soft-delete cascade (transfer/revoke/cancel)
 *
 * Auth (both verbs):
 *   - api key with `user=*:read` (GET) or `user=*:admin` (DELETE)
 *     — superadmin-only at minting
 *   - session / id-token from a superadmin user
 *
 * The DELETE flow is fully described in
 * [`web/lib/userDeleteCascade.server.ts`](../../../lib/userDeleteCascade.server.ts):
 *   1. orphan-sites guard (`successorUid` query param required when the
 *      user owns sites)
 *   2. successor validation (must exist, not soft-deleted, role ≥ admin)
 *   3. site ownership transfer
 *   4. api-key revocation (subcollection + lookup table)
 *   5. background sweep cancelling pending commands the user issued
 *   6. set `users/{uid}.deletedAt`
 *
 * Idempotent: re-issuing DELETE on an already-deleted user returns 200
 * with `alreadyDeleted: true` and no further side-effects.
 *
 * api-sprint wave 3 track 3B (users-api).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problem,
  problemFromError,
  problemNotFound,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { withIdempotency } from '@/lib/idempotency';
import { emitMutation } from '@/lib/auditLogClient';
import {
  applyAuthDeprecations,
  readAndParseJsonBody,
  requirePlatformAuthAndScope,
} from '../../_shared';
import { performUserDeleteCascade } from '@/lib/userDeleteCascade.server';

const UID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

interface RouteParams {
  params: Promise<{ uid: string }>;
}

interface UserDoc {
  email?: string;
  role?: string;
  sites?: string[];
  displayName?: string;
  firstName?: string;
  lastName?: string;
  createdAt?: number | { toMillis?: () => number };
  deletedAt?: number;
}

function timestampToIso(value: unknown): string | null {
  if (typeof value === 'number') return new Date(value).toISOString();
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { toMillis?: () => number }).toMillis === 'function'
  ) {
    try {
      return new Date(
        (value as { toMillis: () => number }).toMillis(),
      ).toISOString();
    } catch {
      return null;
    }
  }
  return null;
}

/* --------------------------------------------------------------------- */
/*  GET — detail                                                         */
/* --------------------------------------------------------------------- */

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { uid } = await params;
    if (!UID_REGEX.test(uid)) {
      return problemValidation('uid must be 1-128 chars', {
        'path.uid': ['letters, digits, underscore, hyphen only'],
      });
    }

    const auth = await requirePlatformAuthAndScope(request, 'user', 'read');
    if (!auth.ok) return auth.response;

    const db = getAdminDb();
    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) {
      return problemNotFound(`user ${uid} not found`);
    }
    const data = userSnap.data() as UserDoc;
    const sites = Array.isArray(data.sites)
      ? data.sites.filter((s): s is string => typeof s === 'string')
      : [];

    return applyAuthDeprecations(
      NextResponse.json({
        uid,
        email: typeof data.email === 'string' ? data.email : null,
        role: typeof data.role === 'string' ? data.role : 'member',
        sites,
        displayName:
          typeof data.displayName === 'string' ? data.displayName : null,
        firstName:
          typeof data.firstName === 'string' ? data.firstName : null,
        lastName: typeof data.lastName === 'string' ? data.lastName : null,
        createdAt: timestampToIso(data.createdAt),
        deletedAt:
          typeof data.deletedAt === 'number' ? data.deletedAt : null,
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'users/[uid]:GET');
  }
}

/* --------------------------------------------------------------------- */
/*  DELETE — soft-delete cascade                                         */
/* --------------------------------------------------------------------- */

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { uid } = await params;
    if (!UID_REGEX.test(uid)) {
      return problemValidation('uid must be 1-128 chars', {
        'path.uid': ['letters, digits, underscore, hyphen only'],
      });
    }

    // DELETE may carry a body for idempotency body-hashing; tolerate
    // empty/missing body without rejecting.
    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    const auth = await requirePlatformAuthAndScope(request, 'user', 'admin');
    if (!auth.ok) return auth.response;

    const successorUid = request.nextUrl.searchParams.get('successorUid');
    if (successorUid && !UID_REGEX.test(successorUid)) {
      return problemValidation('successorUid is malformed', {
        'query.successorUid': ['must match user-id format'],
      });
    }

    return await withIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        const result = await performUserDeleteCascade(uid, { successorUid });

        if (result.kind === 'not_found') {
          return problemNotFound(`user ${uid} not found`);
        }

        if (result.kind === 'orphan_sites') {
          return problem({
            type: ProblemType.Conflict,
            title: 'cannot delete: user owns sites',
            status: 409,
            detail:
              'user owns one or more sites; pass ?successorUid=<uid> to transfer ownership before deletion',
            instance: `/api/users/${uid}`,
            code: 'orphan_sites',
            ownedSites: result.ownedSites,
          });
        }

        if (result.kind === 'successor_invalid') {
          const detailMap: Record<string, string> = {
            not_found: 'successorUid does not match an existing user',
            not_admin:
              'successorUid must reference a user with role admin or superadmin',
            soft_deleted: 'successorUid references a soft-deleted user',
          };
          return problem({
            type: ProblemType.ValidationFailed,
            title: 'invalid successor',
            status: 400,
            detail: detailMap[result.reason],
            instance: `/api/users/${uid}`,
            code: 'successor_invalid',
            successorUid,
            reason: result.reason,
          });
        }

        if (result.kind === 'already_deleted') {
          return applyAuthDeprecations(
            NextResponse.json({
              uid,
              alreadyDeleted: true,
              deletedAt: result.deletedAt,
            }),
            auth.scopeCheck,
          );
        }

        // result.kind === 'deleted'
        emitMutation({
          kind: 'user_mutated',
          siteId: '',
          actor: auth.auth.keyContext
            ? `apiKey:${auth.auth.keyContext.keyId}`
            : `user:${auth.userId}`,
          targetId: uid,
          attributes: {
            endpoint: `/api/users/${uid}`,
            method: 'DELETE',
            verb: 'soft_deleted',
            successorUid: successorUid ?? null,
            transferredSites: result.transferredSites,
            revokedKeyCount: result.revokedKeyIds.length,
          },
        });

        return applyAuthDeprecations(
          NextResponse.json({
            uid,
            alreadyDeleted: false,
            deletedAt: result.deletedAt,
            transferredSites: result.transferredSites,
            revokedKeyIds: result.revokedKeyIds,
          }),
          auth.scopeCheck,
        );
      },
    );
  } catch (err) {
    return problemFromError(err, 'users/[uid]:DELETE');
  }
}
