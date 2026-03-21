import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, requireAdminOrIdToken } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';

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
  async (request: NextRequest) => {
    try {
      const userId = await requireAdminOrIdToken(request);

      const db = getAdminDb();

      // Check if user is admin (admins see all sites)
      const userDoc = await db.collection('users').doc(userId).get();
      const userData = userDoc.data();
      const isAdmin = userData?.role === 'admin';
      const assignedSites: string[] = Array.isArray(userData?.sites) ? userData.sites : [];

      let siteDocs;
      if (isAdmin) {
        // Admins see all sites
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
      if (error instanceof ApiAuthError) {
        return NextResponse.json({ error: (error as ApiAuthError).message }, { status: (error as ApiAuthError).status });
      }
      console.error('admin/sites:', error);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  },
  { strategy: 'user', identifier: 'ip' }
);
