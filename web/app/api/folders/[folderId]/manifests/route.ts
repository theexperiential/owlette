/**
 * GET  /api/folders/{folderId}/manifests?siteId=...
 *      → list manifest versions (rollback ui)
 *
 * POST /api/folders/{folderId}/manifests
 *      input:  { siteId: string, manifest: oci-formatted manifest object }
 *      output: { manifestId: string, currentManifestId: string }
 *      → finalize a new manifest version with **firestore transaction**
 *        for compare-and-swap on currentManifestId. atomic write of
 *        previousManifestId. validates all chunks present in r2.
 *
 * roost wave 2a.3 (POST) and wave 2a.4 (GET).
 *
 * STUB: backing transaction + chunk-presence check not yet wired.
 * implement when waves 0.5/0.6 are provisioned.
 */
import type { NextRequest } from 'next/server';
import { problemFromError, problemValidation } from '@/lib/apiErrors';
import {
  parseJsonBody,
  validateResourceId,
  validateSiteIdBody,
  notImplementedYet,
  requireAuthOrProblem,
  requireSiteScope,
} from '../../../_shared';

interface RouteParams {
  params: Promise<{ folderId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requireAuthOrProblem(request);
    if (!auth.ok) return auth.response;

    const { folderId } = await params;
    const folderError = validateResourceId(folderId, 'folderId');
    if (folderError) return folderError;

    const siteIdParam = request.nextUrl.searchParams.get('siteId');
    if (!siteIdParam) {
      return problemValidation('query param `siteId` is required', {
        'query.siteId': ['required'],
      });
    }
    const site = validateSiteIdBody(siteIdParam, 'query.siteId');
    if (!site.ok) return site.response;

    const scopeError = await requireSiteScope(auth.userId, site.siteId);
    if (scopeError) return scopeError;

    // TODO(wave 2a.4): list immutable manifest history docs at
    //   sites/{siteId}/synced_folders/{folderId}/manifests/
    //   verify folder exists + belongs to siteId; paginate; sort newest-first.
    //   include: {manifestId, manifestUrl, createdAt, createdBy, totalSize, totalFiles, parentManifestId}
    return notImplementedYet(
      `/api/folders/${folderId}/manifests`,
      'wave 2a.4',
      'list immutable manifest history; paginate; verify folder ∈ siteId',
    );
  } catch (err) {
    return problemFromError(err, 'v2/folders/[folderId]/manifests (GET)');
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requireAuthOrProblem(request);
    if (!auth.ok) return auth.response;

    const { folderId } = await params;
    const folderError = validateResourceId(folderId, 'folderId');
    if (folderError) return folderError;

    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as { siteId?: unknown; manifest?: unknown };

    const site = validateSiteIdBody(body.siteId);
    if (!site.ok) return site.response;

    const scopeError = await requireSiteScope(auth.userId, site.siteId);
    if (scopeError) return scopeError;

    if (!body.manifest || typeof body.manifest !== 'object') {
      return problemValidation('field `manifest` is required (oci manifest object)', {
        'body.manifest': ['must be a manifest object'],
      });
    }

    // TODO(wave 2a.3):
    // 1. validate manifest against schema (docs/internal/manifest-format.md)
    // 2. verify folder exists at sites/{siteId}/synced_folders/{folderId}
    //    (404 if missing, prevents enumeration via "folder shape ok but unknown")
    // 3. verify all chunk hashes exist in r2 under per-tenant prefix
    // 4. write manifest body to r2 at project-manifests/{siteId}/{folderId}/{manifestId}.json
    // 5. firestore TRANSACTION:
    //    - read sites/{siteId}/synced_folders/{folderId} → currentManifestId
    //    - write subcollection manifests/{manifestId} (immutable history)
    //    - update folder doc: previousManifestId = old currentManifestId,
    //      currentManifestId = new manifestId, manifestUrl = r2 url
    //    - if currentManifestId changed since read → 412 PreconditionFailed
    // 6. emit telemetry + audit log entry
    // 7. enqueue distribution fan-out (cf trigger fires)
    // 8. honor Idempotency-Key for safe retries
    // 9. respond 201 with { manifestId, currentManifestId }
    return notImplementedYet(
      `/api/folders/${folderId}/manifests`,
      'wave 2a.3',
      'firestore CAS transaction; r2 chunk-presence verify; manifest body to r2; audit log; Idempotency-Key',
    );
  } catch (err) {
    return problemFromError(err, 'v2/folders/[folderId]/manifests (POST)');
  }
}
