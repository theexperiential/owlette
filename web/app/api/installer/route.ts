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
import { problemFromError, problemValidation } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
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

    const pageSizeRaw = Number(sp.get('page_size') ?? DEFAULT_PAGE_SIZE);
    if (sp.has('page_size') && !Number.isFinite(pageSizeRaw)) {
      return problemValidation('page_size must be a positive integer', {
        'query.page_size': ['must be a finite number'],
      });
    }
    const pageSize = Math.min(
      Math.max(1, Number.isFinite(pageSizeRaw) ? Math.floor(pageSizeRaw) : DEFAULT_PAGE_SIZE),
      MAX_PAGE_SIZE,
    );

    const pageToken = sp.get('page_token');
    const includeDeleted = sp.get('includeDeleted') === 'true';

    const db = getAdminDb();
    const versionsCol = db
      .collection('installer_metadata')
      .doc('data')
      .collection('versions');

    let query = versionsCol.orderBy('uploaded_at', 'desc').limit(pageSize + 1);
    if (pageToken) {
      const cursorSnap = await versionsCol.doc(pageToken).get();
      if (cursorSnap.exists) query = query.startAfter(cursorSnap);
    }

    const snap = await query.get();
    const docs = snap.docs.slice(0, pageSize);
    const nextPageToken = snap.docs.length > pageSize ? snap.docs[pageSize].id : '';

    const versions = docs
      .map((d) => {
        const data = d.data() as VersionDoc;
        const deletedAt =
          typeof data.deletedAt === 'number' ? data.deletedAt : null;
        if (!includeDeleted && deletedAt !== null) return null;
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
      .filter((v): v is NonNullable<typeof v> => v !== null);

    return applyAuthDeprecations(
      NextResponse.json({ versions, nextPageToken }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'installer:GET');
  }
}
