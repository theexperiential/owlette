import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError } from '@/lib/apiAuth.server';
import { requireAdminWithSiteAccess } from '@/lib/apiHelpers.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';
import logger from '@/lib/logger';

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
      if (error instanceof ApiAuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      return apiError(error, 'admin/commands/clear');
    }
  },
  { strategy: 'api', identifier: 'ip' }
);
