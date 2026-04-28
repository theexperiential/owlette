/**
 * GET /api/installer
 *
 * List installer versions, newest first. Cursor-paginated per AIP-158.
 *
 * Auth:
 *   - api key with `installer=*:read` scope (superadmin-only at minting)
 *   - session / id-token from a user where `users/{uid}.role === 'superadmin'`
 *
 * Query params:
 *   - page_size (1..100, default 20)
 *   - page_token (opaque — version id of the doc to start after)
 *   - includeDeleted=true to surface soft-deleted entries (default false)
 *
 * Response:
 *   { versions: InstallerVersion[], nextPageToken: string }
 *
 * api-sprint wave 1 track 1B (installer-api).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problemFromError } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  collectFilteredPage,
  parsePagination,
  withPaginationFields,
} from '@/lib/pagination';
import { applyAuthDeprecations, requirePlatformAuthAndScope } from '../_shared';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

interface VersionDoc {
  version?: string;
  download_url?: string | null;
  checksum_sha256?: string | null;
  release_notes?: string | null;
  file_size?: number | null;
  uploaded_at?: number | null;
  uploaded_by?: string | null;
  deletedAt?: number | null;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requirePlatformAuthAndScope(request, 'installer', 'read');
    if (!auth.ok) return auth.response;

    const sp = request.nextUrl.searchParams;

    const parsedPagination = parsePagination(sp, {
      defaultPageSize: DEFAULT_PAGE_SIZE,
      maxPageSize: MAX_PAGE_SIZE,
    });
    if (!parsedPagination.ok) return parsedPagination.response;
    const { pageSize, pageToken } = parsedPagination.pagination;
    const includeDeleted = sp.get('includeDeleted') === 'true';

    const db = getAdminDb();
    const versionsCol = db
      .collection('installer_metadata')
      .doc('data')
      .collection('versions');

    const page = await collectFilteredPage({
      pageSize,
      pageToken,
      fetchPage: async (cursor, limit) => {
        let query = versionsCol.orderBy('uploaded_at', 'desc').limit(limit);
        if (cursor) {
          const cursorSnap = await versionsCol.doc(cursor).get();
          if (cursorSnap.exists) query = query.startAfter(cursorSnap);
        }
        const snap = await query.get();
        return snap.docs;
      },
      include: (doc) => {
        const data = doc.data() as VersionDoc;
        const deletedAt =
          typeof data.deletedAt === 'number' ? data.deletedAt : null;
        return includeDeleted || deletedAt === null;
      },
    });

    const versions = page.docs
      .map((d) => {
        const data = d.data() as VersionDoc;
        const deletedAt =
          typeof data.deletedAt === 'number' ? data.deletedAt : null;
        return {
          version: data.version || d.id,
          download_url: data.download_url ?? null,
          checksum_sha256: data.checksum_sha256 ?? null,
          release_notes: data.release_notes ?? null,
          file_size: data.file_size ?? null,
          uploaded_at: data.uploaded_at ?? null,
          uploaded_by: data.uploaded_by ?? null,
          deletedAt,
        };
      })

    return applyAuthDeprecations(
      NextResponse.json(withPaginationFields({ versions }, page.nextPageToken)),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'installer:GET');
  }
}
