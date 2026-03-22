import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError } from '@/lib/apiAuth.server';
import { requireAdminWithSiteAccess } from '@/lib/apiHelpers.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { withProcessConfig, ProcessConfigError } from '@/lib/processConfig.server';
import logger from '@/lib/logger';

/**
 * GET /api/admin/processes?siteId=xxx&machineId=yyy
 *
 * List all processes for a machine, merging config (authoritative) with live status.
 */
export const GET = withRateLimit(
  async (request: NextRequest) => {
    try {
      const siteId = request.nextUrl.searchParams.get('siteId');
      const machineId = request.nextUrl.searchParams.get('machineId');

      if (!siteId || !machineId) {
        return NextResponse.json(
          { error: 'Missing required query params: siteId, machineId' },
          { status: 400 }
        );
      }

      await requireAdminWithSiteAccess(request, siteId);

      const db = getAdminDb();

      // Read config and status in parallel
      const [configSnap, statusSnap] = await Promise.all([
        db.collection('config').doc(siteId).collection('machines').doc(machineId).get(),
        db.collection('sites').doc(siteId).collection('machines').doc(machineId).get(),
      ]);

      const configProcesses = configSnap.exists
        ? (configSnap.data()?.processes || [])
        : [];

      // Build a map of live status data keyed by process id
      const statusData = statusSnap.exists ? statusSnap.data() : null;
      const metricsProcesses = statusData?.metrics?.processes || {};

      // Merge config (authoritative) with live status
      const processes = configProcesses.map((proc: any, index: number) => {
        const liveData = metricsProcesses[proc.id] || metricsProcesses[proc.name] || {};
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
          // Live status fields
          status: liveData.status || 'unknown',
          pid: liveData.pid ?? null,
          responsive: liveData.responsive ?? false,
          last_updated: liveData.last_updated ?? null,
        };
      });

      return NextResponse.json({ success: true, processes });
    } catch (error: unknown) {
      if (error instanceof ApiAuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      console.error('admin/processes GET:', error);
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Internal server error' },
        { status: 500 }
      );
    }
  },
  { strategy: 'user', identifier: 'ip' }
);

/**
 * POST /api/admin/processes
 *
 * Create a new process in the machine's config.
 *
 * Request body:
 *   siteId: string
 *   machineId: string
 *   name: string (required)
 *   exe_path: string (required)
 *   file_path?: string
 *   cwd?: string
 *   priority?: string
 *   visibility?: string
 *   time_delay?: string
 *   time_to_init?: string
 *   relaunch_attempts?: string
 *   launch_mode?: 'off' | 'always' | 'scheduled'
 *   schedules?: ScheduleBlock[]
 */
export const POST = withRateLimit(
  async (request: NextRequest) => {
    try {
      const body = await request.json();
      const { siteId, machineId, name, exe_path, ...optionalFields } = body;

      if (!siteId || !machineId) {
        return NextResponse.json(
          { error: 'Missing required fields: siteId, machineId' },
          { status: 400 }
        );
      }

      if (!name || !exe_path) {
        return NextResponse.json(
          { error: 'Missing required fields: name, exe_path' },
          { status: 400 }
        );
      }

      await requireAdminWithSiteAccess(request, siteId);

      const newProcessId = crypto.randomUUID();
      const launchMode = optionalFields.launch_mode || 'off';

      const processId = await withProcessConfig(siteId, machineId, (processes) => {
        const newProcess = {
          id: newProcessId,
          name,
          exe_path,
          file_path: optionalFields.file_path || '',
          cwd: optionalFields.cwd || '',
          priority: optionalFields.priority || 'Normal',
          visibility: optionalFields.visibility || 'Show',
          time_delay: optionalFields.time_delay || '0',
          time_to_init: optionalFields.time_to_init || '10',
          relaunch_attempts: optionalFields.relaunch_attempts || '3',
          autolaunch: launchMode !== 'off',
          launch_mode: launchMode,
          schedules: optionalFields.schedules || null,
        };

        return {
          processes: [...processes, newProcess],
          result: newProcessId,
        };
      });

      logger.info(`Process created: ${name} on ${machineId}`, { context: 'admin/processes' });

      return NextResponse.json({ success: true, processId });
    } catch (error: unknown) {
      if (error instanceof ApiAuthError || error instanceof ProcessConfigError) {
        const status = 'status' in error ? error.status : 500;
        return NextResponse.json({ error: error.message }, { status });
      }
      console.error('admin/processes POST:', error);
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Internal server error' },
        { status: 500 }
      );
    }
  },
  { strategy: 'user', identifier: 'ip' }
);
