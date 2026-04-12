import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, requireAdminOrIdToken } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';

/**
 * GET /api/admin/installer/versions?limit=10
 *
 * List all uploaded installer versions, ordered by upload date (newest first).
 */
export const GET = withRateLimit(
  async (request: NextRequest) => {
    try {
      await requireAdminOrIdToken(request);

      const limitParam = request.nextUrl.searchParams.get('limit');
      const queryLimit = Math.min(Math.max(parseInt(limitParam || '20', 10) || 20, 1), 100);

      const db = getAdminDb();
      const versionsRef = db.collection('installer_metadata').doc('data').collection('versions');
      const snapshot = await versionsRef
        .orderBy('uploaded_at', 'desc')
        .limit(queryLimit)
        .get();

      const versions = snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          version: data.version || doc.id,
          download_url: data.download_url || null,
          checksum_sha256: data.checksum_sha256 || null,
          release_notes: data.release_notes || null,
          file_size: data.file_size || null,
          uploaded_at: data.uploaded_at || null,
          uploaded_by: data.uploaded_by || null,
        };
      });

      return NextResponse.json({ success: true, versions });
    } catch (error: unknown) {
      if (error instanceof ApiAuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      return apiError(error, 'admin/installer/versions');
    }
  },
  { strategy: 'api', identifier: 'ip' }
);
