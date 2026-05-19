/**
 * POST /api/users/{uid}/assign-sites
 *
 * Public contract preserved from the api-sprint users route. The mutation
 * body now lives in `assignSiteToUser` and this shim only handles HTTP
 * parsing, idempotency, and authorization.
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
import { assignSiteToUser, MAX_SITES_PER_REQUEST } from '@/lib/actions/assignSiteToUser.server';

const UID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

type RouteParams = { uid: string };

interface AssignBody {
  siteIds?: unknown;
}

function auditActor(ctx: PlatformHandlerContext): string {
  return ctx.auth.keyContext
    ? `apiKey:${ctx.auth.keyContext.keyId}`
    : `user:${ctx.actor.userId}`;
}

export const POST = authorizedPlatformHandler<RouteParams>({
  capability: Capability.SITE_MEMBER_MANAGE,
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
        const body = parsed.body as AssignBody;
        const siteIds = body.siteIds;
        if (!Array.isArray(siteIds) || siteIds.length === 0) {
          return problemValidation(
            'siteIds is required and must be a non-empty array',
            { 'body.siteIds': ['must be a non-empty array of site ids'] },
          );
        }

        const result = await assignSiteToUser(
          {
            auditActor: auditActor(ctx),
            endpoint: `/api/users/${uid}/assign-sites`,
            method: 'POST',
          },
          { uid, siteIds: siteIds as string[] },
        );

        if (result.kind === 'not_found') {
          return problemNotFound(`user ${uid} not found`);
        }
        if (result.kind === 'deleted') {
          return problemValidation(
            'cannot assign sites to a soft-deleted user',
            { 'path.uid': ['user is soft-deleted'] },
          );
        }
        if (result.kind === 'too_many') {
          return problemValidation(
            `siteIds contains ${result.count} entries; max is ${MAX_SITES_PER_REQUEST}`,
            {
              'body.siteIds': [
                `maximum ${MAX_SITES_PER_REQUEST} site ids per request`,
              ],
            },
          );
        }
        if (result.kind === 'invalid_format') {
          return problemValidation('siteIds contains malformed entries', {
            'body.siteIds': [
              'each entry must match site-id format (1-128 chars: letters, digits, underscore, hyphen)',
            ],
          });
        }
        if (result.kind === 'unknown_sites') {
          return problem({
            type: ProblemType.ValidationFailed,
            title: 'unknown site(s)',
            status: 400,
            detail: 'one or more siteIds do not match an existing site',
            instance: `/api/users/${uid}/assign-sites`,
            code: 'unknown_site',
            unknownSites: result.unknownSites,
          });
        }

        return applyAuthDeprecations(
          NextResponse.json({
            uid,
            assignedSiteIds: result.assignedSiteIds,
          }),
          ctx.scopeCheck,
        );
      },
    );
  } catch (err) {
    return problemFromError(err, 'users/[uid]/assign-sites:POST');
  }
});
