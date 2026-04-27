import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { ProcessConfigError, type ProcessConfig } from '@/lib/processConfig.server';
import { apiError } from '@/lib/apiErrorResponse';
import {
  authorizedLegacyBodySiteHandler,
  authorizedSiteHandler,
  type SiteHandlerContext,
} from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import {
  ActionInputError,
  createProcess,
} from '@/lib/actions/createProcess.server';

const LEGACY_ADMIN_SUNSET = 'Wed, 30 Sep 2026 00:00:00 GMT';

/**
 * GET /api/admin/processes?siteId=xxx&machineId=yyy
 *
 * List all processes for a machine, merging config (authoritative) with live status.
 */
export const GET = authorizedSiteHandler({
  capability: Capability.MACHINE_CONFIG_WRITE,
  siteIdParam: 'query',
  targetKind: 'machine',
  apiKeyPermission: 'read',
  apiKeyScope: { resource: 'machine', id: '*', permission: 'read' },
  deprecated: true,
  canonicalUrl: '/api/sites/{siteId}/machines/{machineId}/processes',
  sunsetDate: LEGACY_ADMIN_SUNSET,
  routeName: 'GET /api/admin/processes',
})(async (request: NextRequest) => {
  try {
    const siteId = request.nextUrl.searchParams.get('siteId');
    const machineId = request.nextUrl.searchParams.get('machineId');

    if (!siteId || !machineId) {
      return NextResponse.json(
        { error: 'Missing required query params: siteId, machineId' },
        { status: 400 }
      );
    }

    const db = getAdminDb();

    const [configSnap, statusSnap] = await Promise.all([
      db.collection('config').doc(siteId).collection('machines').doc(machineId).get(),
      db.collection('sites').doc(siteId).collection('machines').doc(machineId).get(),
    ]);

    const configProcesses = configSnap.exists
      ? (configSnap.data()?.processes || [])
      : [];

    const statusData = statusSnap.exists ? statusSnap.data() : null;
    const metricsProcesses = statusData?.metrics?.processes || {};

    const processes = (configProcesses as ProcessConfig[]).map((proc, index) => {
      const live = (metricsProcesses[proc.id] || metricsProcesses[proc.name] || {}) as {
        status?: string;
        pid?: number | null;
        responsive?: boolean;
        last_updated?: string | number | null;
      };
      return {
        id: proc.id,
        name: proc.name,
        exe_path: proc.exe_path || '',
        file_path: proc.file_path || '',
        cwd: proc.cwd || '',
        priority: proc.priority || 'Normal',
        visibility: proc.visibility || 'Show',
        time_delay: proc.time_delay || '0',
        time_to_init: proc.time_to_init || '10',
        relaunch_attempts: proc.relaunch_attempts || '3',
        autolaunch: proc.autolaunch ?? false,
        launch_mode: proc.launch_mode || 'off',
        schedules: proc.schedules || null,
        schedulePresetId: proc.schedulePresetId || null,
        index: proc.index ?? index,
        status: live.status || 'unknown',
        pid: live.pid ?? null,
        responsive: live.responsive ?? false,
        last_updated: live.last_updated ?? null,
      };
    });

    return NextResponse.json({ success: true, processes });
  } catch (error: unknown) {
    return apiError(error, 'admin/processes GET');
  }
});

/**
 * POST /api/admin/processes
 *
 * Create a new process in the machine's config.
 */
export const POST = authorizedLegacyBodySiteHandler({
  capability: Capability.MACHINE_CONFIG_WRITE,
  targetKind: 'process',
  deprecated: true,
  canonicalUrl: '/api/sites/{siteId}/machines/{machineId}/processes',
  sunsetDate: LEGACY_ADMIN_SUNSET,
  routeName: 'POST /api/admin/processes',
})(async (request: NextRequest, ctx: SiteHandlerContext) => {
  try {
    const body = await request.json();
    const { siteId, machineId, name, exe_path, ...optionalFields } = body;

    if (!siteId || !machineId) {
      return NextResponse.json(
        { error: 'Missing required fields: siteId, machineId' },
        { status: 400 }
      );
    }

    const result = await createProcess(
      {
        siteId: ctx.siteId,
        actor: ctx.actor,
        auditActor: actorIdentifier(ctx),
      },
      {
        machineId,
        name,
        exe_path,
        file_path: optionalFields.file_path,
        cwd: optionalFields.cwd,
        priority: optionalFields.priority,
        visibility: optionalFields.visibility,
        time_delay: optionalFields.time_delay,
        time_to_init: optionalFields.time_to_init,
        relaunch_attempts: optionalFields.relaunch_attempts,
        launch_mode: optionalFields.launch_mode,
        schedules: optionalFields.schedules,
      },
    );

    return NextResponse.json({ success: true, processId: result.processId });
  } catch (error: unknown) {
    if (error instanceof ActionInputError || error instanceof ProcessConfigError) {
      const status = 'status' in error ? error.status : 500;
      return NextResponse.json({ error: error.message }, { status });
    }
    return apiError(error, 'admin/processes POST');
  }
});

function actorIdentifier(ctx: SiteHandlerContext): string {
  return ctx.auth.keyContext
    ? `apiKey:${ctx.auth.keyContext.keyId}`
    : `user:${ctx.actor.userId}`;
}
