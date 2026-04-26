/**
 * POST /api/sites/{siteId}/project-distributions/{distId}/cancel
 *
 * Cancels every target on a project distribution that is still in a
 * pre-flight state (`pending` / `downloading` / `extracting`):
 *   - flips each affected target to `cancelled` on the distribution doc
 *   - purges the queued `distribute_project` command from each target
 *     machine's `commands/pending` doc
 *   - fans out a `cancel_distribution` command to short-circuit any
 *     mid-fetch agent
 *
 * Targets that are already `completed` / `failed` / `cancelled` are left
 * untouched. Requires `site=<id>:write` and an `Idempotency-Key` header.
 *
 * Mirror of `/api/sites/{siteId}/deployments/{deploymentId}/cancel`.
 * Action core: `web/lib/actions/cancelDistribution.server.ts`.
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
import { generateCorrelationId } from '@/lib/auditLog.server';
import { cancelDistribution } from '@/lib/actions/cancelDistribution.server';

interface RouteParams {
  params: Promise<{ siteId: string; distId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId, distId } = await params;

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
        const correlationId = generateCorrelationId();
        const actorIdentifier = auth.auth.keyContext
          ? `apiKey:${auth.auth.keyContext.keyId}`
          : `user:${auth.userId}`;

        const result = await cancelDistribution({
          siteId,
          distributionId: distId,
          actorIdentifier,
          correlationId,
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
}
