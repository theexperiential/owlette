import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError } from '@/lib/apiAuth.server';
import { requireAdminWithSiteAccess, getRouteParam } from '@/lib/apiHelpers.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { withProcessConfig, ProcessConfigError, type ScheduleBlock } from '@/lib/processConfig.server';
import logger from '@/lib/logger';

const VALID_MODES = ['off', 'always', 'scheduled'] as const;

/**
 * PATCH /api/admin/processes/{processId}/launch-mode
 *
 * Set a process's launch mode and optional schedule.
 *
 * Request body:
 *   siteId: string
 *   machineId: string
 *   mode: 'off' | 'always' | 'scheduled'
 *   schedules?: ScheduleBlock[]
 *   schedulePresetId?: string
 */
export const PATCH = withRateLimit(
  async (request: NextRequest) => {
    try {
      // /api/admin/processes/{processId}/launch-mode → segments: ['api','admin','processes','{id}','launch-mode']
      const processId = getRouteParam(request, 3);
      const body = await request.json();
      const { siteId, machineId, mode, schedules, schedulePresetId } = body;

      if (!siteId || !machineId) {
        return NextResponse.json(
          { error: 'Missing required fields: siteId, machineId' },
          { status: 400 }
        );
      }

      if (!mode || !VALID_MODES.includes(mode)) {
        return NextResponse.json(
          { error: `Invalid mode. Must be one of: ${VALID_MODES.join(', ')}` },
          { status: 400 }
        );
      }

      if (mode === 'scheduled' && (!schedules || !Array.isArray(schedules) || schedules.length === 0)) {
        return NextResponse.json(
          { error: 'Schedules array is required when mode is "scheduled"' },
          { status: 400 }
        );
      }

      await requireAdminWithSiteAccess(request, siteId);

      // Update config via transaction
      await withProcessConfig(siteId, machineId, (processes) => {
        const index = processes.findIndex((p) => p.id === processId);
        if (index === -1) {
          throw new ProcessConfigError(404, 'Process not found');
        }

        const updated = [...processes];
        updated[index] = {
          ...updated[index],
          launch_mode: mode,
          autolaunch: mode !== 'off',
          ...(schedules !== undefined ? { schedules } : {}),
          ...(schedulePresetId !== undefined ? { schedulePresetId: schedulePresetId || null } : {}),
        };

        return { processes: updated, result: undefined };
      });

      // Mirror launch_mode + schedules to status doc for immediate UI visibility
      // (matches the pattern in useFirestore.ts setLaunchMode)
      try {
        const db = getAdminDb();
        const statusRef = db.collection('sites').doc(siteId).collection('machines').doc(machineId);

        const statusUpdate: Record<string, unknown> = {
          [`metrics.processes.${processId}.launch_mode`]: mode,
          [`metrics.processes.${processId}.autolaunch`]: mode !== 'off',
        };

        if (schedules !== undefined) {
          // Clean schedule blocks for Firestore
          const cleanSchedules = (schedules as ScheduleBlock[])?.map((b) => {
            const clean: Record<string, unknown> = { days: b.days, ranges: b.ranges };
            if (b.name) clean.name = b.name;
            if (b.colorIndex != null) clean.colorIndex = b.colorIndex;
            return clean;
          });
          statusUpdate[`metrics.processes.${processId}.schedules`] = cleanSchedules;
        }

        if (schedulePresetId !== undefined) {
          statusUpdate[`metrics.processes.${processId}.schedulePresetId`] = schedulePresetId || null;
        }

        await statusRef.update(statusUpdate);
      } catch {
        // Non-critical: status doc mirror is for UI convenience only
      }

      logger.info(`Launch mode set to ${mode} for process ${processId}`, { context: 'admin/processes' });

      return NextResponse.json({ success: true });
    } catch (error: unknown) {
      if (error instanceof ApiAuthError || error instanceof ProcessConfigError) {
        const status = 'status' in error ? error.status : 500;
        return NextResponse.json({ error: error.message }, { status });
      }
      console.error('admin/processes/launch-mode PATCH:', error);
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Internal server error' },
        { status: 500 }
      );
    }
  },
  { strategy: 'api', identifier: 'ip' }
);
