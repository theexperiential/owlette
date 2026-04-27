import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';
import { authorizedPlatformHandler } from '@/lib/authorizedHandler.server';

/**
 * GET /api/admin/keys
 *
 * List all active API keys for the authenticated admin user.
 * Returns metadata only — never the raw key or hash.
 *
 * Response:
 *   {
 *     success: true,
 *     keys: [
 *       { id: string, name: string, keyPrefix: string, createdAt: number, lastUsedAt: number | null }
 *     ]
 *   }
 */
export const GET = withRateLimit(
  authorizedPlatformHandler({
    capability: 'GLOBAL_SETTINGS_WRITE',
    deprecated: true,
    routeName: 'GET /api/admin/keys',
  })(async (_request: NextRequest, ctx) => {
    try {
      const userId = ctx.actor.userId;
      const db = getAdminDb();

      const keysSnap = await db
        .collection('users')
        .doc(userId)
        .collection('api_keys')
        .orderBy('createdAt', 'desc')
        .get();

      const keys = keysSnap.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          name: data.name,
          keyPrefix: data.keyPrefix,
          createdAt: data.createdAt,
          lastUsedAt: data.lastUsedAt,
        };
      });

      return NextResponse.json({ success: true, keys });
    } catch (error: unknown) {
      return apiError(error, 'admin/keys');
    }
  }),
  { strategy: 'api', identifier: 'ip' }
);
