import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { authorizedPlatformHandler, type PlatformHandlerContext } from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import { getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';

const LEGACY_ADMIN_SUNSET = 'Wed, 30 Sep 2026 00:00:00 GMT';

/**
 * GET /api/admin/sites
 *
 * List all sites the authenticated admin has access to.
 *
 * Response:
 *   {
 *     success: true,
 *     sites: [
 *       { id: string, name: string, createdAt: string | null, owner: string | null }
 *     ]
 *   }
 */
export const GET = withRateLimit(
  authorizedPlatformHandler({
    capability: Capability.SITE_MEMBER_MANAGE,
    targetKind: 'site',
    apiKeyScope: { resource: 'user', permission: 'admin' },
    deprecated: true,
    canonicalUrl: '/api/sites',
    sunsetDate: LEGACY_ADMIN_SUNSET,
    routeName: 'GET /api/admin/sites',
  })(
  async (_request: NextRequest, ctx: PlatformHandlerContext) => {
    try {
      const db = getAdminDb();

      // Check if user is superadmin (superadmins see all sites — platform god-mode).
      const userDoc = await db.collection('users').doc(ctx.actor.userId).get();
      const userData = userDoc.data();
      const isSuperadmin = userData?.role === 'superadmin';
      const assignedSites: string[] = Array.isArray(userData?.sites) ? userData.sites : [];

      let siteDocs;
      if (isSuperadmin) {
        // Superadmins see all sites
        const snap = await db.collection('sites').get();
        siteDocs = snap.docs;
      } else {
        // Regular users see only assigned sites
        if (assignedSites.length === 0) {
          return NextResponse.json({ success: true, sites: [] });
        }
        // Firestore 'in' queries support up to 30 items
        const chunks: string[][] = [];
        for (let i = 0; i < assignedSites.length; i += 30) {
          chunks.push(assignedSites.slice(i, i + 30));
        }
        siteDocs = [];
        for (const chunk of chunks) {
          const snap = await db.collection('sites')
            .where('__name__', 'in', chunk)
            .get();
          siteDocs.push(...snap.docs);
        }
      }

      const sites = siteDocs.map((doc) => {
        const data = doc.data();
        const createdAt = data.createdAt?.toDate?.()
          ? data.createdAt.toDate().toISOString()
          : null;

        return {
          id: doc.id,
          name: data.name || doc.id,
          createdAt,
          owner: data.owner || null,
        };
      });

      sites.sort((a, b) => a.name.localeCompare(b.name));

      return NextResponse.json({ success: true, sites });
    } catch (error: unknown) {
      return apiError(error, 'admin/sites');
    }
  }),
  { strategy: 'api', identifier: 'ip' }
);
