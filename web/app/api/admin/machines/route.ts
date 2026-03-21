import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, requireAdminOrIdToken, assertUserHasSiteAccess } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';

/**
 * GET /api/admin/machines?siteId=xxx
 *
 * List all machines for a site with their online status.
 *
 * Response:
 *   {
 *     success: true,
 *     machines: [
 *       {
 *         id: string,
 *         name: string,
 *         online: boolean,
 *         lastHeartbeat: string (ISO),
 *         agentVersion: string,
 *         os: string
 *       }
 *     ]
 *   }
 */
export const GET = withRateLimit(
  async (request: NextRequest) => {
    try {
      const userId = await requireAdminOrIdToken(request);
      const siteId = request.nextUrl.searchParams.get('siteId');

      if (!siteId) {
        return NextResponse.json({ error: 'Missing required param: siteId' }, { status: 400 });
      }

      await assertUserHasSiteAccess(userId, siteId);

      const db = getAdminDb();
      const machinesSnap = await db
        .collection('sites')
        .doc(siteId)
        .collection('machines')
        .get();

      const machines = machinesSnap.docs.map((doc) => {
        const data = doc.data();
        const lastHeartbeat = data.presence?.last_seen || data.last_seen || null;

        return {
          id: doc.id,
          name: data.name || data.machine_name || doc.id,
          online: !!(data.online ?? data.presence?.online),
          lastHeartbeat: lastHeartbeat ? new Date(lastHeartbeat).toISOString() : null,
          agentVersion: data.agent_version || data.presence?.agent_version || null,
          os: data.os || data.presence?.os || null,
        };
      });

      // Sort by name
      machines.sort((a, b) => a.name.localeCompare(b.name));

      logger.info(`Listed ${machines.length} machines for site ${siteId}`, { context: 'admin/machines' });
      return NextResponse.json({ success: true, machines });
    } catch (error: any) {
      if (error instanceof ApiAuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      console.error('admin/machines:', error);
      return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
    }
  },
  { strategy: 'user', identifier: 'ip' }
);
