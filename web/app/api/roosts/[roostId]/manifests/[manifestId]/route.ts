/**
 * GET /api/roosts/{roostId}/manifests/{manifestId}?siteId=...
 *     → Full OCI manifest (body fetched from R2) + history metadata + stats.
 *
 * roost public api wave 3.2.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { timestampToIso } from '@/lib/firestoreTime.server';
import {
  problem,
  problemFromError,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { getManifestBody } from '@/lib/r2Client.server';
import {
  applyAuthDeprecations,
  requireRoostAuthAndScope,
  validateResourceId,
  validateSiteIdBody,
} from '../../../../_shared';

interface RouteParams {
  params: Promise<{ roostId: string; manifestId: string }>;
}

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

    const db = getAdminDb();
    const manifestRef = db
      .collection('sites')
      .doc(site.siteId)
      .collection('roosts')
      .doc(roostId)
      .collection('manifests')
      .doc(manifestId);

    const manifestSnap = await manifestRef.get();
    if (!manifestSnap.exists) {
      return problem({
        type: ProblemType.NotFound,
        title: 'manifest not found',
        status: 404,
        detail: `manifest ${manifestId} not found on roost ${roostId}`,
        instance: `/api/roosts/${roostId}/manifests/${manifestId}`,
      });
    }

    const metadata = manifestSnap.data() ?? {};
    const body = await getManifestBody(site.siteId, roostId, manifestId);

    if (!body) {
      // metadata doc exists but body is gone — treat as 410 Gone so clients
      // know the pointer is stale vs a transient missing-history error.
      return problem({
        type: ProblemType.NotFound,
        title: 'manifest body gone',
        status: 410,
        detail: `manifest ${manifestId} metadata exists but the body has been reclaimed`,
        instance: `/api/roosts/${roostId}/manifests/${manifestId}`,
      });
    }

    return applyAuthDeprecations(
      NextResponse.json({
        manifestId,
        roostId,
        siteId: site.siteId,
        manifest: body,
        metadata: {
          manifestUrl: metadata.manifestUrl ?? null,
          createdAt: timestampToIso(metadata.createdAt),
          createdBy: metadata.createdBy ?? null,
          totalSize: typeof metadata.totalSize === 'number' ? metadata.totalSize : 0,
          totalFiles: typeof metadata.totalFiles === 'number' ? metadata.totalFiles : 0,
          parentManifestId: metadata.parentManifestId ?? null,
        },
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/roosts/[roostId]/manifests/[manifestId]:GET');
  }
}
