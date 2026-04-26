/**
 * POST /api/users/{uid}/promote
 *
 * Public contract preserved from the api-sprint users route. The mutation
 * body now lives in `setUserRole` and this shim only handles HTTP parsing,
 * idempotency, and authorization.
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
import { withIdempotency } from '@/lib/idempotency';
import { authorizedPlatformHandler, type PlatformHandlerContext } from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import { applyAuthDeprecations, readAndParseJsonBody } from '../../../_shared';
import { MIN_SUPERADMINS, setUserRole, type UserRole } from '@/lib/actions/setUserRole.server';

const UID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
const PROMOTE_ROLES = new Set<UserRole>(['admin', 'superadmin']);

type RouteParams = { uid: string };

interface PromoteBody {
  role?: unknown;
}

function auditActor(ctx: PlatformHandlerContext): string {
  return ctx.auth.keyContext
    ? `apiKey:${ctx.auth.keyContext.keyId}`
    : `user:${ctx.actor.userId}`;
}

export const POST = authorizedPlatformHandler<RouteParams>({
  capability: Capability.USER_ROLE_MANAGE,
  targetKind: 'user',
  apiKeyScope: { resource: 'user', permission: 'write' },
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

    return await withIdempotency(
      request,
      {
        userId: ctx.actor.userId,
        environment: ctx.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        const body = parsed.body as PromoteBody;
        const role = body.role;
        if (typeof role !== 'string' || !PROMOTE_ROLES.has(role as UserRole)) {
          return problemValidation(
            'role is required and must be admin or superadmin',
            { 'body.role': ['must be one of: admin, superadmin'] },
          );
        }

        const result = await setUserRole(
          {
            auditActor: auditActor(ctx),
            endpoint: `/api/users/${uid}/promote`,
            method: 'POST',
          },
          { uid, role: role as UserRole },
        );

        if (result.kind === 'not_found') {
          return problemNotFound(`user ${uid} not found`);
        }
        if (result.kind === 'deleted') {
          return problemValidation(
            'cannot promote a soft-deleted user; restore the account first',
            { 'path.uid': ['user is soft-deleted'] },
          );
        }
        if (result.kind === 'last_superadmin') {
          return problem({
            type: ProblemType.Conflict,
            title: 'cannot change last superadmin role',
            status: 409,
            detail: `cannot change role: only ${result.activeSuperadmins} active superadmin(s) remain; floor is ${MIN_SUPERADMINS}`,
            instance: `/api/users/${uid}/promote`,
            code: 'last_superadmin',
            minSuperadmins: MIN_SUPERADMINS,
            currentActiveCount: result.activeSuperadmins,
          });
        }

        return applyAuthDeprecations(
          NextResponse.json({
            uid,
            role: result.newRole,
            previousRole: result.previousRole,
            changed: result.kind === 'updated',
          }),
          ctx.scopeCheck,
        );
      },
    );
  } catch (err) {
    return problemFromError(err, 'users/[uid]/promote:POST');
  }
});
