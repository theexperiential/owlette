/**
 * GET /api/roosts/{roostId}/manifests/{manifestId}/files?siteId=...&limit=100&cursor=...
 *     → Paginated file list within a manifest.
 *       cursor is an opaque integer offset (AIP-158 style — callers treat
 *       it as an opaque string). Each page includes path, size, and the
 *       chunk hash list.
 *
 * roost public api wave 3.2.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problem,
  problemFromError,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { getManifestBody } from '@/lib/r2Client.server';
import {
  applyAuthDeprecations,
  requireRoostAuthAndScope,
  validateResourceId,
  validateSiteIdBody,
} from '../../../../../_shared';

interface RouteParams {
  params: Promise<{ roostId: string; manifestId: string }>;
}

interface ManifestFile {
  path: string;
  size: number;
  chunks: Array<{ hash: string; size: number }>;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { roostId, manifestId } = await params;

    const roostError = validateResourceId(roostId, 'roostId');
    if (roostError) return roostError;
    const manifestError = validateResourceId(manifestId, 'manifestId');
    if (manifestError) return manifestError;

    const siteIdParam = request.nextUrl.searchParams.get('siteId');
    if (!siteIdParam) {
      return problemValidation('query param `siteId` is required', {
        'query.siteId': ['required'],
      });
    }
    const site = validateSiteIdBody(siteIdParam, 'query.siteId');
    if (!site.ok) return site.response;

    const auth = await requireRoostAuthAndScope(request, site.siteId, roostId, 'read');
    if (!auth.ok) return auth.response;

    const limitRaw = Number(request.nextUrl.searchParams.get('limit') ?? DEFAULT_LIMIT);
    const limit = Math.min(
      Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : DEFAULT_LIMIT),
      MAX_LIMIT,
    );
    const cursorRaw = request.nextUrl.searchParams.get('cursor');
    const cursor = cursorRaw ? parseInt(cursorRaw, 10) : 0;
    if (cursorRaw && (!Number.isFinite(cursor) || cursor < 0)) {
      return problemValidation('cursor must be a non-negative integer', {
        'query.cursor': ['invalid cursor'],
      });
    }

    const body = await getManifestBody(site.siteId, roostId, manifestId);
    if (!body) {
      return problem({
        type: ProblemType.NotFound,
        title: 'manifest not found',
        status: 404,
        detail: `manifest ${manifestId} not found on roost ${roostId}`,
        instance: `/api/roosts/${roostId}/manifests/${manifestId}/files`,
      });
    }

    const manifest = body as { files?: ManifestFile[] };
    const allFiles = Array.isArray(manifest.files) ? manifest.files : [];
    const page = allFiles.slice(cursor, cursor + limit);
    const nextOffset = cursor + page.length;
    const nextPageToken = nextOffset < allFiles.length ? String(nextOffset) : '';

    return applyAuthDeprecations(
      NextResponse.json({
        manifestId,
        roostId,
        siteId: site.siteId,
        total: allFiles.length,
        files: page,
        nextPageToken,
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/roosts/[roostId]/manifests/[manifestId]/files:GET');
  }
}
