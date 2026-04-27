import { NextRequest, NextResponse } from 'next/server';
import { ProcessConfigError } from '@/lib/processConfig.server';
import { apiError } from '@/lib/apiErrorResponse';
import {
  authorizedLegacyBodySiteHandler,
  type SiteHandlerContext,
} from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import {
  ActionInputError,
  type ActionContext,
} from '@/lib/actions/createProcess.server';
import {
  setProcessLaunchMode,
  VALID_LAUNCH_MODES,
} from '@/lib/actions/setProcessLaunchMode.server';

const LEGACY_ADMIN_SUNSET = 'Wed, 30 Sep 2026 00:00:00 GMT';

type RouteParams = { processId: string };

/**
 * PATCH /api/admin/processes/{processId}/launch-mode
 *
 * Set a process's launch mode and optional schedule.
 */
export const PATCH = authorizedLegacyBodySiteHandler<RouteParams>({
  capability: Capability.MACHINE_CONFIG_WRITE,
  targetKind: 'process',
  targetIdParam: 'processId',
  deprecated: true,
  canonicalUrl: '/api/sites/{siteId}/machines/{machineId}/processes/{processId}/launch-mode',
  sunsetDate: LEGACY_ADMIN_SUNSET,
  routeName: 'PATCH /api/admin/processes/{processId}/launch-mode',
})(async (request: NextRequest, ctx: SiteHandlerContext, routeContext) => {
  try {
    const processId = await readProcessId(request, routeContext.params);
    const body = await request.json();
    const { siteId, machineId, mode, schedules, schedulePresetId } = body;

    if (!siteId || !machineId) {
      return NextResponse.json(
        { error: 'Missing required fields: siteId, machineId' },
        { status: 400 }
      );
    }

    if (!mode || !VALID_LAUNCH_MODES.includes(mode)) {
      return NextResponse.json(
        { error: `Invalid mode. Must be one of: ${VALID_LAUNCH_MODES.join(', ')}` },
        { status: 400 }
      );
    }

    if (mode === 'scheduled' && (!schedules || !Array.isArray(schedules) || schedules.length === 0)) {
      return NextResponse.json(
        { error: 'Schedules array is required when mode is "scheduled"' },
        { status: 400 }
      );
    }

    await setProcessLaunchMode(actionContext(ctx), {
      machineId,
      processId,
      mode,
      schedules,
      schedulePresetId,
    });

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    if (error instanceof ActionInputError || error instanceof ProcessConfigError) {
      const status = 'status' in error ? error.status : 500;
      return NextResponse.json({ error: error.message }, { status });
    }
    return apiError(error, 'admin/processes/launch-mode');
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
