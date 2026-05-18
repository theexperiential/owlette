/**
 * GET /api/roosts/{roostId}/versions/{versionRef}/files?siteId=...&limit=100&cursor=...
 *     → Paginated file list within a version.
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
import { getAdminDb } from '@/lib/firebase-admin';
import {
  parsePagination,
  withPaginationFields,
} from '@/lib/pagination';
import { getVersionBody } from '@/lib/r2Client.server';
import { resolveVersion, ResolveVersionError } from '@/lib/resolveVersion';
import { gateOrProceed } from '@/lib/roostKillSwitch';
import {
  applyAuthDeprecations,
  requireRoostAuthAndScope,
  validateResourceId,
  validateSiteIdBody,
} from '../../../../../_shared';

interface RouteParams {
  params: Promise<{ roostId: string; versionRef: string }>;
}

interface VersionFile {
  path: string;
  size: number;
  chunks: Array<{ hash: string; size: number }>;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

async function readSiteDocForGate(siteId: string): Promise<Record<string, unknown> | null> {
  const snap = await getAdminDb().collection('sites').doc(siteId).get();
  return snap.exists ? (snap.data() ?? null) : null;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { roostId, versionRef } = await params;

    const roostError = validateResourceId(roostId, 'roostId');
    if (roostError) return roostError;

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

    const gateRes = await gateOrProceed(site.siteId, readSiteDocForGate);
    if (gateRes) return gateRes;

    const parsedPagination = parsePagination(request.nextUrl.searchParams, {
      defaultPageSize: DEFAULT_LIMIT,
      maxPageSize: MAX_LIMIT,
    });
    if (!parsedPagination.ok) return parsedPagination.response;
    const { pageSize, pageToken } = parsedPagination.pagination;
    const offset = pageToken ? parseInt(pageToken, 10) : 0;
    if (pageToken && (!Number.isFinite(offset) || offset < 0 || String(offset) !== pageToken)) {
      return problemValidation('page_token must be a non-negative integer offset', {
        'query.page_token': ['invalid page token'],
      });
    }
    const prefix = request.nextUrl.searchParams.get('prefix') ?? '';

    // Resolve the ref to a concrete versionId.
    let versionId: string;
    try {
      const resolved = await resolveVersion({
        roostId,
        siteId: site.siteId,
        ref: versionRef,
      });
      versionId = resolved.versionId;
    } catch (err) {
      if (err instanceof ResolveVersionError) {
        return problem({
          type: err.status === 404 ? ProblemType.NotFound : ProblemType.ValidationFailed,
          title: err.status === 404 ? 'version not found' : 'versionRef malformed',
          status: err.status,
          detail: err.message,
          instance: `/api/roosts/${roostId}/versions/${versionRef}/files`,
          code: err.code,
        });
      }
      throw err;
    }

    const body = await getVersionBody(site.siteId, roostId, versionId);
    if (!body) {
      return problem({
        type: ProblemType.NotFound,
        title: 'version body gone',
        status: 410,
        detail: `version ${versionId} metadata exists but the body has been reclaimed`,
        instance: `/api/roosts/${roostId}/versions/${versionRef}/files`,
      });
    }

    const versionBody = body as { files?: VersionFile[] };
    const allFiles = Array.isArray(versionBody.files) ? versionBody.files : [];
    const filteredFiles = prefix
      ? allFiles.filter((file) => file.path.startsWith(prefix))
      : allFiles;
    const page = filteredFiles.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    const nextPageToken = nextOffset < filteredFiles.length ? String(nextOffset) : '';

    return applyAuthDeprecations(
      NextResponse.json(
        withPaginationFields(
          {
            versionId,
            roostId,
            siteId: site.siteId,
            total: filteredFiles.length,
            files: page,
            items: page,
          },
          nextPageToken,
        ),
      ),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/roosts/[roostId]/versions/[versionRef]/files:GET');
  }
}
