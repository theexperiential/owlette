/**
 * POST /api/users/{uid}/remove-sites
 *
 * Public contract preserved from the api-sprint users route. The mutation
 * body now lives in `removeSiteFromUser` and this shim only handles HTTP
 * parsing, idempotency, and authorization.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problemFromError,
  problemNotFound,
  problemValidation,
} from '@/lib/apiErrors';
import { withIdempotency } from '@/lib/idempotency';
import { authorizedPlatformHandler, type PlatformHandlerContext } from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import { applyAuthDeprecations, readAndParseJsonBody } from '../../../_shared';
import { MAX_SITES_PER_REQUEST, removeSiteFromUser } from '@/lib/actions/removeSiteFromUser.server';

const UID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

type RouteParams = { uid: string };

interface RemoveBody {
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
        const body = parsed.body as RemoveBody;
        const siteIds = body.siteIds;
        if (!Array.isArray(siteIds) || siteIds.length === 0) {
          return problemValidation(
            'siteIds is required and must be a non-empty array',
            { 'body.siteIds': ['must be a non-empty array of site ids'] },
          );
        }

        const result = await removeSiteFromUser(
          {
            auditActor: auditActor(ctx),
            endpoint: `/api/users/${uid}/remove-sites`,
            method: 'POST',
          },
          { uid, siteIds: siteIds as string[] },
        );

        if (result.kind === 'not_found') {
          return problemNotFound(`user ${uid} not found`);
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

        return applyAuthDeprecations(
          NextResponse.json({
            uid,
            removedSiteIds: result.removedSiteIds,
            cancelledCommandCount: result.cancelledCommandCount,
          }),
          ctx.scopeCheck,
        );
      },
    );
  } catch (err) {
    return problemFromError(err, 'users/[uid]/remove-sites:POST');
  }
});
