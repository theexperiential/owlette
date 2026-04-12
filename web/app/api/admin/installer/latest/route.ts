import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit } from '@/lib/withRateLimit';
import { ApiAuthError, requireAdminOrIdToken } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';

/**
 * GET /api/admin/installer/latest
 *
 * Get the latest installer metadata (version, download URL, checksum, release notes).
 * Global endpoint — not site-scoped.
 */
export const GET = withRateLimit(
  async (request: NextRequest) => {
    try {
      await requireAdminOrIdToken(request);

      const db = getAdminDb();
      const latestDoc = await db.collection('installer_metadata').doc('latest').get();

      if (!latestDoc.exists) {
        return NextResponse.json(
          { error: 'No installer metadata found' },
          { status: 404 }
        );
      }

      const data = latestDoc.data()!;

      return NextResponse.json({
        success: true,
        installer: {
          version: data.version || null,
          download_url: data.download_url || null,
          checksum_sha256: data.checksum_sha256 || null,
          release_notes: data.release_notes || null,
          file_size: data.file_size || null,
          uploaded_at: data.uploaded_at || data.release_date || null,
        },
      });
    } catch (error: unknown) {
      if (error instanceof ApiAuthError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      return apiError(error, 'admin/installer/latest');
    }
  },
  { strategy: 'api', identifier: 'ip' }
);
