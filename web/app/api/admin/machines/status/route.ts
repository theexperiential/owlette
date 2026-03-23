import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, requireAdminOrIdToken, assertUserHasSiteAccess } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';

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
  async (request: NextRequest) => {
    try {
      const userId = await requireAdminOrIdToken(request);
      const siteId = request.nextUrl.searchParams.get('siteId');
      const machineId = request.nextUrl.searchParams.get('machineId');

      if (!siteId || !machineId) {
        return NextResponse.json(
          { error: 'Missing required params: siteId, machineId' },
          { status: 400 }
        );
      }

      await assertUserHasSiteAccess(userId, siteId);

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

      const lastHeartbeat = machineData.presence?.last_seen || machineData.last_seen || null;

      const machine = {
        id: machineId,
        name: machineData.name || machineData.machine_name || machineId,
        online: !!(machineData.online ?? machineData.presence?.online),
        lastHeartbeat: lastHeartbeat ? new Date(lastHeartbeat).toISOString() : null,
        metrics: machineData.metrics || machineData.status?.metrics || null,
        processes: machineData.processes || machineData.status?.processes || configData?.processes || [],
        health: machineData.health || machineData.status?.health || null,
        agentVersion: machineData.agent_version || machineData.presence?.agent_version || null,
        os: machineData.os || machineData.presence?.os || null,
      };

      logger.info(`Status read for ${machineId} on site ${siteId}`, { context: 'admin/machines/status' });
      return NextResponse.json({ success: true, machine });
    } catch (error: any) {
      if (error instanceof ApiAuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      console.error('admin/machines/status:', error);
      return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
    }
  },
  { strategy: 'api', identifier: 'ip' }
);
