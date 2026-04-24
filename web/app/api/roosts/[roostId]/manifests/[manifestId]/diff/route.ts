/**
 * GET /api/roosts/{roostId}/manifests/{manifestId}/diff?siteId=...&against=<otherManifestId>
 *     → Diff two manifests at file-level granularity.
 *       Returns {added, removed, changed, unchanged} with per-file reason.
 *
 * `manifestId` is treated as the "to" (target) manifest; `against` is the
 * "from" (current) manifest. Matches the semantics of the existing
 * rollback-dialog diff: added = "will appear after applying this manifest."
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
import { diffManifests, summariseDiff } from '@/lib/manifestDiff';
import type { ManifestFileEntry } from '@/lib/chunking';
import {
  applyAuthDeprecations,
  requireRoostAuthAndScope,
  validateResourceId,
  validateSiteIdBody,
} from '../../../../../_shared';

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

    const againstParam = request.nextUrl.searchParams.get('against');
    if (!againstParam) {
      return problemValidation('query param `against` is required (manifestId to diff against)', {
        'query.against': ['required'],
      });
    }
    const againstError = validateResourceId(againstParam, 'against');
    if (againstError) return againstError;

    const auth = await requireRoostAuthAndScope(request, site.siteId, roostId, 'read');
    if (!auth.ok) return auth.response;

    // Fetch both bodies in parallel — the diff is pure so ordering doesn't matter.
    const [toBody, fromBody] = await Promise.all([
      getManifestBody(site.siteId, roostId, manifestId),
      getManifestBody(site.siteId, roostId, againstParam),
    ]);

    if (!toBody) {
      return problem({
        type: ProblemType.NotFound,
        title: 'manifest not found',
        status: 404,
        detail: `manifest ${manifestId} not found on roost ${roostId}`,
        instance: `/api/roosts/${roostId}/manifests/${manifestId}/diff`,
      });
    }
    if (!fromBody) {
      return problem({
        type: ProblemType.NotFound,
        title: 'against manifest not found',
        status: 404,
        detail: `manifest ${againstParam} (against) not found on roost ${roostId}`,
        instance: `/api/roosts/${roostId}/manifests/${manifestId}/diff`,
      });
    }

    const toFiles = extractFiles(toBody);
    const fromFiles = extractFiles(fromBody);
    const diff = diffManifests(fromFiles, toFiles);
    const summary = summariseDiff(fromFiles, toFiles, diff);

    return applyAuthDeprecations(
      NextResponse.json({
        manifestId,
        against: againstParam,
        roostId,
        siteId: site.siteId,
        summary,
        added: diff.added.map((f) => ({
          path: f.path,
          size: f.size,
          reason: 'added' as const,
          chunks: f.chunks.length,
        })),
        removed: diff.removed.map((f) => ({
          path: f.path,
          size: f.size,
          reason: 'removed' as const,
          chunks: f.chunks.length,
        })),
        modified: diff.changed.map((c) => ({
          path: c.path,
          fromSize: c.from.size,
          toSize: c.to.size,
          reason: 'modified' as const,
          fromChunks: c.from.chunks.length,
          toChunks: c.to.chunks.length,
        })),
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/roosts/[roostId]/manifests/[manifestId]/diff:GET');
  }
}

function extractFiles(manifest: unknown): ManifestFileEntry[] {
  if (!manifest || typeof manifest !== 'object') return [];
  const m = manifest as { files?: unknown };
  if (!Array.isArray(m.files)) return [];
  return m.files.filter(
    (f): f is ManifestFileEntry =>
      f !== null &&
      typeof f === 'object' &&
      typeof (f as { path?: unknown }).path === 'string' &&
      typeof (f as { size?: unknown }).size === 'number' &&
      Array.isArray((f as { chunks?: unknown }).chunks),
  );
}
