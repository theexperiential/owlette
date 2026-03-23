import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError } from '@/lib/apiAuth.server';
import { requireAdminWithSiteAccess, getRouteParam } from '@/lib/apiHelpers.server';
import { withProcessConfig, ProcessConfigError } from '@/lib/processConfig.server';
import logger from '@/lib/logger';

/**
 * PATCH /api/admin/processes/{processId}
 *
 * Update a process's config fields.
 *
 * Request body:
 *   siteId: string
 *   machineId: string
 *   ...fieldsToUpdate (any subset of process config fields)
 */
export const PATCH = withRateLimit(
  async (request: NextRequest) => {
    try {
      // /api/admin/processes/{processId} → segments: ['api','admin','processes','{id}']
      const processId = getRouteParam(request, 3);
      const body = await request.json();
      const { siteId, machineId, ...fieldsToUpdate } = body;

      if (!siteId || !machineId) {
        return NextResponse.json(
          { error: 'Missing required fields: siteId, machineId' },
          { status: 400 }
        );
      }

      if (Object.keys(fieldsToUpdate).length === 0) {
        return NextResponse.json(
          { error: 'No fields to update' },
          { status: 400 }
        );
      }

      await requireAdminWithSiteAccess(request, siteId);

      // Don't allow changing the process id
      delete fieldsToUpdate.id;

      await withProcessConfig(siteId, machineId, (processes) => {
        const index = processes.findIndex((p) => p.id === processId);
        if (index === -1) {
          throw new ProcessConfigError(404, 'Process not found');
        }

        const updated = [...processes];
        updated[index] = { ...updated[index], ...fieldsToUpdate };

        return { processes: updated, result: undefined };
      });

      logger.info(`Process updated: ${processId} on ${machineId}`, { context: 'admin/processes' });

      return NextResponse.json({ success: true });
    } catch (error: unknown) {
      if (error instanceof ApiAuthError || error instanceof ProcessConfigError) {
        const status = 'status' in error ? error.status : 500;
        return NextResponse.json({ error: error.message }, { status });
      }
      console.error('admin/processes PATCH:', error);
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Internal server error' },
        { status: 500 }
      );
    }
  },
  { strategy: 'api', identifier: 'ip' }
);

/**
 * DELETE /api/admin/processes/{processId}?siteId=xxx&machineId=yyy
 *
 * Delete a process from the machine's config.
 */
export const DELETE = withRateLimit(
  async (request: NextRequest) => {
    try {
      const processId = getRouteParam(request, 3);
      const siteId = request.nextUrl.searchParams.get('siteId');
      const machineId = request.nextUrl.searchParams.get('machineId');

      if (!siteId || !machineId) {
        return NextResponse.json(
          { error: 'Missing required query params: siteId, machineId' },
          { status: 400 }
        );
      }

      await requireAdminWithSiteAccess(request, siteId);

      await withProcessConfig(siteId, machineId, (processes) => {
        const index = processes.findIndex((p) => p.id === processId);
        if (index === -1) {
          throw new ProcessConfigError(404, 'Process not found');
        }

        return {
          processes: processes.filter((p) => p.id !== processId),
          result: undefined,
        };
      });

      logger.info(`Process deleted: ${processId} on ${machineId}`, { context: 'admin/processes' });

      return NextResponse.json({ success: true });
    } catch (error: unknown) {
      if (error instanceof ApiAuthError || error instanceof ProcessConfigError) {
        const status = 'status' in error ? error.status : 500;
        return NextResponse.json({ error: error.message }, { status });
      }
      console.error('admin/processes DELETE:', error);
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Internal server error' },
        { status: 500 }
      );
    }
  },
  { strategy: 'api', identifier: 'ip' }
);
