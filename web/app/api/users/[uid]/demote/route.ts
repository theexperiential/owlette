/**
 * POST /api/users/{uid}/demote
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
import { MIN_SUPERADMINS, setUserRole } from '@/lib/actions/setUserRole.server';

const UID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

type RouteParams = { uid: string };

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
        const result = await setUserRole(
          {
            auditActor: auditActor(ctx),
            endpoint: `/api/users/${uid}/demote`,
            method: 'POST',
          },
          { uid, role: 'member' },
        );

        if (result.kind === 'not_found') {
          return problemNotFound(`user ${uid} not found`);
        }
        if (result.kind === 'deleted') {
          return problemValidation(
            'cannot demote a soft-deleted user; restore the account first',
            { 'path.uid': ['user is soft-deleted'] },
          );
        }
        if (result.kind === 'last_superadmin') {
          return problem({
            type: ProblemType.Conflict,
            title: 'cannot demote last superadmin',
            status: 409,
            detail: `cannot demote: only ${result.activeSuperadmins} active superadmin(s) remain; floor is ${MIN_SUPERADMINS}`,
            instance: `/api/users/${uid}/demote`,
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
    return problemFromError(err, 'users/[uid]/demote:POST');
  }
});
