import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import { getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';
import logger from '@/lib/logger';

const LEGACY_ADMIN_SUNSET = 'Wed, 30 Sep 2026 00:00:00 GMT';

/**
 * DELETE /api/admin/commands/clear?siteId=xxx&machineId=xxx
 *
 * Clear all pending commands for a machine. Useful for:
 * - Clearing a backlog of stale commands after testing
 * - Emergency stop-all for a machine
 * - Recovering from agent issues
 *
 * Returns the number of commands that were cleared.
 */
export const DELETE = withRateLimit(
  authorizedSiteHandler({
    capability: Capability.MACHINE_EXEC_COMMAND,
    siteIdParam: 'query',
    targetKind: 'machine',
    deprecated: true,
    canonicalUrl: '/api/sites/{siteId}/machines/{machineId}/commands',
    sunsetDate: LEGACY_ADMIN_SUNSET,
    routeName: 'DELETE /api/admin/commands/clear',
  })(
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

      const db = getAdminDb();
      const pendingRef = db
        .collection('sites').doc(siteId)
        .collection('machines').doc(machineId)
        .collection('commands').doc('pending');

      const snap = await pendingRef.get();

      if (!snap.exists) {
        return NextResponse.json({ success: true, cleared: 0 });
      }

      const data = snap.data() || {};
      const count = Object.keys(data).length;

      await pendingRef.delete();

      logger.info(
        `Cleared ${count} pending command(s) for machine ${machineId}`,
        { context: 'admin/commands/clear' }
      );

      return NextResponse.json({ success: true, cleared: count });
    } catch (error: unknown) {
      return apiError(error, 'admin/commands/clear');
    }
  }),
  { strategy: 'api', identifier: 'ip' }
);
