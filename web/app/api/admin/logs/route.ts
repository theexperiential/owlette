import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, requireAdminOrIdToken, assertUserHasSiteAccess } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import logger from '@/lib/logger';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * GET /api/admin/logs?siteId=xxx&limit=50&action=process_crash&level=error&machineId=yyy&since=ISO
 *
 * Read activity logs with optional filters.
 *
 * Query params:
 *   siteId: string       — Required
 *   limit?: number       — Max results (default: 50, max: 200)
 *   action?: string      — Filter by action type
 *   level?: string       — Filter by level (info, warning, error)
 *   machineId?: string   — Filter by machine
 *   since?: string       — ISO timestamp, only logs after this time
 *
 * Response:
 *   {
 *     success: true,
 *     logs: [
 *       { id, timestamp, action, level, machineId, processName, details }
 *     ]
 *   }
 */
export const GET = withRateLimit(
  async (request: NextRequest) => {
    try {
      const userId = await requireAdminOrIdToken(request);
      const params = request.nextUrl.searchParams;
      const siteId = params.get('siteId');

      if (!siteId) {
        return NextResponse.json({ error: 'Missing required param: siteId' }, { status: 400 });
      }

      await assertUserHasSiteAccess(userId, siteId);

      const db = getAdminDb();
      const limitParam = Math.min(parseInt(params.get('limit') || '') || DEFAULT_LIMIT, MAX_LIMIT);
      const action = params.get('action');
      const level = params.get('level');
      const machineId = params.get('machineId');
      const since = params.get('since');

      let query: FirebaseFirestore.Query = db
        .collection('sites')
        .doc(siteId)
        .collection('logs');

      if (action) {
        query = query.where('action', '==', action);
      }

      if (level) {
        query = query.where('level', '==', level);
      }

      if (machineId) {
        query = query.where('machineId', '==', machineId);
      }

      if (since) {
        query = query.where('timestamp', '>', since);
      }

      query = query.orderBy('timestamp', 'desc').limit(limitParam);

      const logsSnap = await query.get();
      const logs = logsSnap.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          timestamp: data.timestamp || null,
          action: data.action || null,
          level: data.level || null,
          machineId: data.machineId || null,
          processName: data.processName || null,
          details: data.details || null,
        };
      });

      logger.info(`Read ${logs.length} logs for site ${siteId}`, { context: 'admin/logs' });
      return NextResponse.json({ success: true, logs });
    } catch (error: any) {
      if (error instanceof ApiAuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      console.error('admin/logs:', error);
      return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
    }
  },
  { strategy: 'user', identifier: 'ip' }
);
