import { NextRequest, NextResponse } from 'next/server';
import { ProcessConfigError } from '@/lib/processConfig.server';
import { apiError } from '@/lib/apiErrorResponse';
import logger from '@/lib/logger';
import {
  authorizedLegacyBodySiteHandler,
  authorizedSiteHandler,
  type SiteHandlerContext,
} from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import {
  ActionInputError,
  type ActionContext,
} from '@/lib/actions/createProcess.server';
import { updateProcess } from '@/lib/actions/updateProcess.server';
import { deleteProcess } from '@/lib/actions/deleteProcess.server';

const LEGACY_ADMIN_SUNSET = 'Wed, 30 Sep 2026 00:00:00 GMT';

type RouteParams = { processId: string };

/**
 * PATCH /api/admin/processes/{processId}
 *
 * Update a process's config fields.
 */
export const PATCH = authorizedLegacyBodySiteHandler<RouteParams>({
  capability: Capability.MACHINE_CONFIG_WRITE,
  targetKind: 'process',
  targetIdParam: 'processId',
  deprecated: true,
  canonicalUrl: '/api/sites/{siteId}/machines/{machineId}/processes/{processId}',
  sunsetDate: LEGACY_ADMIN_SUNSET,
  routeName: 'PATCH /api/admin/processes/{processId}',
})(async (request: NextRequest, ctx: SiteHandlerContext, routeContext) => {
  try {
    const processId = await readProcessId(request, routeContext.params);
    const body = await request.json();
    const { siteId, machineId, ...fieldsToUpdate } = body;

    if (!siteId || !machineId) {
      return NextResponse.json(
        { error: 'Missing required fields: siteId, machineId' },
        { status: 400 }
      );
    }

    delete fieldsToUpdate.id;
    delete fieldsToUpdate.processId;

    await updateProcess(actionContext(ctx), {
      machineId,
      processId,
      patch: fieldsToUpdate,
    });

    logger.info(`Process updated: ${processId} on ${machineId}`, { context: 'admin/processes' });

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    if (error instanceof ActionInputError || error instanceof ProcessConfigError) {
      const status = 'status' in error ? error.status : 500;
      return NextResponse.json({ error: error.message }, { status });
    }
    return apiError(error, 'admin/processes PATCH');
  }
});

/**
 * DELETE /api/admin/processes/{processId}?siteId=xxx&machineId=yyy
 *
 * Delete a process from the machine's config.
 */
export const DELETE = authorizedSiteHandler<RouteParams>({
  capability: Capability.MACHINE_CONFIG_WRITE,
  siteIdParam: 'query',
  targetKind: 'process',
  targetIdParam: 'processId',
  deprecated: true,
  canonicalUrl: '/api/sites/{siteId}/machines/{machineId}/processes/{processId}',
  sunsetDate: LEGACY_ADMIN_SUNSET,
  routeName: 'DELETE /api/admin/processes/{processId}',
})(async (request: NextRequest, ctx: SiteHandlerContext, routeContext) => {
  try {
    const processId = await readProcessId(request, routeContext.params);
    const siteId = request.nextUrl.searchParams.get('siteId');
    const machineId = request.nextUrl.searchParams.get('machineId');

    if (!siteId || !machineId) {
      return NextResponse.json(
        { error: 'Missing required query params: siteId, machineId' },
        { status: 400 }
      );
    }

    const result = await deleteProcess(actionContext(ctx), { machineId, processId });
    if (result.alreadyDeleted) {
      return NextResponse.json({ error: `Process ${processId} not found` }, { status: 404 });
    }

    logger.info(`Process deleted: ${processId} on ${machineId}`, { context: 'admin/processes' });

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    if (error instanceof ProcessConfigError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return apiError(error, 'admin/processes DELETE');
  }
});

function actionContext(ctx: SiteHandlerContext): ActionContext {
  return {
    siteId: ctx.siteId,
    actor: ctx.actor,
    auditActor: ctx.auth.keyContext
      ? `apiKey:${ctx.auth.keyContext.keyId}`
      : `user:${ctx.actor.userId}`,
  };
}

async function readProcessId(
  request: NextRequest,
  paramsPromise: Promise<RouteParams>,
): Promise<string> {
  const params = await paramsPromise;
  if (params.processId) return params.processId;
  const segments = request.nextUrl.pathname.split('/').filter(Boolean);
  const idx = segments.indexOf('processes');
  return decodeURIComponent(segments[idx + 1] ?? '');
}
