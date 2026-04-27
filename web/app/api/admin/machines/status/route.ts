import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import { getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';
import logger from '@/lib/logger';

const LEGACY_ADMIN_SUNSET = 'Wed, 30 Sep 2026 00:00:00 GMT';

/**
 * GET /api/admin/machines/status?siteId=xxx&machineId=yyy
 *
 * Get detailed status for a specific machine.
 *
 * Response:
 *   {
 *     success: true,
 *     machine: {
 *       id, name, online, lastHeartbeat,
 *       metrics: { cpu, memory, disk, gpu },
 *       processes: [ { name, status, pid, autolaunch, uptime } ],
 *       health: { status, error_code?, error_message? },
 *       agentVersion, os
 *     }
 *   }
 */
export const GET = withRateLimit(
  authorizedSiteHandler({
    capability: Capability.MACHINE_CONFIG_WRITE,
    siteIdParam: 'query',
    targetKind: 'machine',
    apiKeyPermission: 'read',
    deprecated: true,
    canonicalUrl: '/api/sites/{siteId}/machines/{machineId}',
    sunsetDate: LEGACY_ADMIN_SUNSET,
    routeName: 'GET /api/admin/machines/status',
  })(
  async (request: NextRequest) => {
    try {
      const siteId = request.nextUrl.searchParams.get('siteId');
      const machineId = request.nextUrl.searchParams.get('machineId');

      if (!siteId || !machineId) {
        return NextResponse.json(
          { error: 'Missing required params: siteId, machineId' },
          { status: 400 }
        );
      }

      const db = getAdminDb();

      // Read machine document (presence + status)
      const machineDoc = await db
        .collection('sites')
        .doc(siteId)
        .collection('machines')
        .doc(machineId)
        .get();

      if (!machineDoc.exists) {
        return NextResponse.json({ error: 'Machine not found' }, { status: 404 });
      }

      const machineData = machineDoc.data()!;

      // Read config document for process configuration
      const configDoc = await db
        .collection('config')
        .doc(siteId)
        .collection('machines')
        .doc(machineId)
        .get();

      const configData = configDoc.exists ? configDoc.data() : null;

      const lastHeartbeat = machineData.lastHeartbeat || null;

      const machine = {
        id: machineId,
        name: machineData.name || machineData.machine_name || machineId,
        online: !!machineData.online,
        lastHeartbeat: lastHeartbeat ? new Date(lastHeartbeat).toISOString() : null,
        metrics: machineData.metrics || machineData.status?.metrics || null,
        processes: machineData.processes || machineData.status?.processes || configData?.processes || [],
        health: machineData.health || machineData.status?.health || null,
        agentVersion: machineData.agent_version || machineData.presence?.agent_version || null,
        os: machineData.os || machineData.presence?.os || null,
      };

      logger.info(`Status read for ${machineId} on site ${siteId}`, { context: 'admin/machines/status' });
      return NextResponse.json({ success: true, machine });
    } catch (error: unknown) {
      return apiError(error, 'admin/machines/status');
    }
  }),
  { strategy: 'api', identifier: 'ip' }
);
