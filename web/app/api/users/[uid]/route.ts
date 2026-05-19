/**
 * GET    /api/users/{uid}     - user detail incl. site assignments
 * DELETE /api/users/{uid}     - soft-delete cascade (transfer/revoke/cancel)
 *
 * GET keeps the existing read-only public route. DELETE now delegates to
 * `deleteUser` behind `authorizedPlatformHandler(USER_DELETE)` while
 * preserving the response/error contract from the api-sprint users route.
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
import {
  applyAuthDeprecations,
  readAndParseJsonBody,
  requirePlatformAuthAndScope,
} from '../../_shared';
import { authorizedPlatformHandler, type PlatformHandlerContext } from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import { deleteUser } from '@/lib/actions/deleteUser.server';

const UID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

type RouteParams = { uid: string };

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

function auditActor(ctx: PlatformHandlerContext): string {
  return ctx.auth.keyContext
    ? `apiKey:${ctx.auth.keyContext.keyId}`
    : `user:${ctx.actor.userId}`;
}

/* --------------------------------------------------------------------- */
/*  GET - detail                                                         */
/* --------------------------------------------------------------------- */

export async function GET(request: NextRequest, { params }: { params: Promise<RouteParams> }) {
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
/*  DELETE - soft-delete cascade                                         */
/* --------------------------------------------------------------------- */

export const DELETE = authorizedPlatformHandler<RouteParams>({
  capability: Capability.USER_DELETE,
  targetKind: 'user',
  apiKeyScope: { resource: 'user', permission: 'admin' },
})(async (request: NextRequest, ctx: PlatformHandlerContext, routeContext) => {
  try {
    const { uid } = await routeContext!.params;
    if (!UID_REGEX.test(uid)) {
      return problemValidation('uid must be 1-128 chars', {
        'path.uid': ['letters, digits, underscore, hyphen only'],
      });
    }

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    const successorUid = request.nextUrl.searchParams.get('successorUid');
    if (successorUid && !UID_REGEX.test(successorUid)) {
      return problemValidation('successorUid is malformed', {
        'query.successorUid': ['must match user-id format'],
      });
    }

    return await withIdempotency(
      request,
      {
        userId: ctx.actor.userId,
        environment: ctx.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        const result = await deleteUser(
          {
            auditActor: auditActor(ctx),
            endpoint: `/api/users/${uid}`,
            method: 'DELETE',
          },
          { uid, successorUid },
        );

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
            ctx.scopeCheck,
          );
        }

        return applyAuthDeprecations(
          NextResponse.json({
            uid,
            alreadyDeleted: false,
            deletedAt: result.deletedAt,
            transferredSites: result.transferredSites,
            revokedKeyIds: result.revokedKeyIds,
            authDisabled: result.authDisabled,
          }),
          ctx.scopeCheck,
        );
      },
    );
  } catch (err) {
    return problemFromError(err, 'users/[uid]:DELETE');
  }
});
