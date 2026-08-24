/**
 * POST /api/sites/{siteId}/project-distributions/{distId}/cancel
 *
 * For every target still pre-flight (`pending`/`downloading`/`extracting`):
 * flip it to `cancelled`, purge the queued `distribute_project` from the
 * machine's `commands/pending`, and fan out `cancel_distribution` to
 * short-circuit a mid-fetch agent. Terminal targets are untouched.
 *
 * Requires `site=<id>:write` + `Idempotency-Key`. Mirrors
 * `/deployments/{deploymentId}/cancel`; core is
 * `web/lib/actions/cancelDistribution.server.ts`.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problem, problemFromError, ProblemType } from '@/lib/apiErrors';
import {
  applyAuthDeprecations,
  readAndParseJsonBody,
  requireSiteAuthAndScope,
} from '../../../../../_shared';
import { withIdempotency } from '@/lib/idempotency';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import { cancelDistribution } from '@/lib/actions/cancelDistribution.server';

type RouteParams = { siteId: string; distId: string };

export const POST = authorizedSiteHandler<RouteParams>({
  capability: 'DISTRIBUTION_MANAGE',
  siteIdParam: 'path',
  targetKind: 'distribution',
  targetIdParam: 'distId',
})(async (request: NextRequest, ctx, routeContext) => {
  try {
    const { siteId, distId } = await routeContext.params;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    const auth = await requireSiteAuthAndScope(request, siteId, 'write');
    if (!auth.ok) return auth.response;

    return withIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        const actorIdentifier = auth.auth.keyContext
          ? `apiKey:${auth.auth.keyContext.keyId}`
          : `user:${auth.userId}`;

        const result = await cancelDistribution({
          siteId,
          distributionId: distId,
          actorIdentifier,
          correlationId: ctx.correlationId,
        });

        if (!result.ok) {
          if (result.code === 'not_found') {
            return problem({
              type: ProblemType.NotFound,
              title: 'not found',
              status: 404,
              detail: result.message,
              instance: `/api/sites/${siteId}/project-distributions/${distId}/cancel`,
            });
          }
          // 'no_cancellable_targets'
          return problem({
            type: ProblemType.Conflict,
            title: 'no cancellable targets',
            status: 409,
            detail: result.message,
            instance: `/api/sites/${siteId}/project-distributions/${distId}/cancel`,
            code: 'no_cancellable_targets',
          });
        }

        return applyAuthDeprecations(
          NextResponse.json({
            distributionId: result.distributionId,
            siteId: result.siteId,
            status: result.status,
            cancelled: result.cancelled,
            machine_ids: result.machine_ids,
          }),
          auth.scopeCheck,
        );
      },
    );
  } catch (err) {
    return problemFromError(
      err,
      'sites/[siteId]/project-distributions/[distId]/cancel:POST',
    );
  }
});
