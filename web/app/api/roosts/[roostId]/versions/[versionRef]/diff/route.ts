/**
 * GET /api/roosts/{roostId}/versions/{versionRef}/diff?siteId=...&against=<otherVersionRef>
 *     → Diff two versions at file-level granularity.
 *       Returns {added, removed, changed, unchanged} with per-file reason.
 *
 * `versionRef` is treated as the "to" (target) version; `against` is the
 * "from" (current) version. Matches the semantics of the existing
 * rollback-dialog diff: added = "will appear after applying this version."
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
import { getVersionBody } from '@/lib/r2Client.server';
import { diffVersions, summariseDiff } from '@/lib/versionDiff';
import type { VersionFileEntry } from '@/lib/chunking';
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

    const againstParam = request.nextUrl.searchParams.get('against');
    if (!againstParam) {
      return problemValidation('query param `against` is required (versionRef to diff against)', {
        'query.against': ['required'],
      });
    }

    const auth = await requireRoostAuthAndScope(request, site.siteId, roostId, 'read');
    if (!auth.ok) return auth.response;

    const gateRes = await gateOrProceed(site.siteId, readSiteDocForGate);
    if (gateRes) return gateRes;

    // Resolve both refs. Run in parallel — they're independent lookups
    // against the same roost. Any failure short-circuits with the
    // appropriate problem envelope. We preserve which side failed so
    // the caller knows whether their `to` or `against` was the issue.
    const instance = `/api/roosts/${roostId}/versions/${versionRef}/diff`;
    let toId: string;
    let fromId: string;
    try {
      const [toResolved, fromResolved] = await Promise.all([
        resolveVersion({ roostId, siteId: site.siteId, ref: versionRef }),
        resolveVersion({ roostId, siteId: site.siteId, ref: againstParam }),
      ]);
      toId = toResolved.versionId;
      fromId = fromResolved.versionId;
    } catch (err) {
      if (err instanceof ResolveVersionError) {
        return problem({
          type:
            err.status === 404 ? ProblemType.NotFound : ProblemType.ValidationFailed,
          title: err.status === 404 ? 'version not found' : 'versionRef malformed',
          status: err.status,
          detail: err.message,
          instance,
          code: err.code,
        });
      }
      throw err;
    }

    // Fetch both bodies in parallel — the diff is pure so ordering doesn't matter.
    const [toBody, fromBody] = await Promise.all([
      getVersionBody(site.siteId, roostId, toId),
      getVersionBody(site.siteId, roostId, fromId),
    ]);

    if (!toBody) {
      return problem({
        type: ProblemType.NotFound,
        title: 'version body gone',
        status: 410,
        detail: `version ${toId} body has been reclaimed`,
        instance: `/api/roosts/${roostId}/versions/${versionRef}/diff`,
      });
    }
    if (!fromBody) {
      return problem({
        type: ProblemType.NotFound,
        title: 'against version body gone',
        status: 410,
        detail: `version ${fromId} body has been reclaimed`,
        instance: `/api/roosts/${roostId}/versions/${versionRef}/diff`,
      });
    }

    const toFiles = extractFiles(toBody);
    const fromFiles = extractFiles(fromBody);
    const diff = diffVersions(fromFiles, toFiles);
    const summary = summariseDiff(fromFiles, toFiles, diff);

    return applyAuthDeprecations(
      NextResponse.json({
        versionId: toId,
        fromVersion: fromId,
        toVersion: toId,
        against: fromId,
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
    return problemFromError(err, 'v2/roosts/[roostId]/versions/[versionRef]/diff:GET');
  }
}

function extractFiles(version: unknown): VersionFileEntry[] {
  if (!version || typeof version !== 'object') return [];
  const m = version as { files?: unknown };
  if (!Array.isArray(m.files)) return [];
  return m.files.filter(
    (f): f is VersionFileEntry =>
      f !== null &&
      typeof f === 'object' &&
      typeof (f as { path?: unknown }).path === 'string' &&
      typeof (f as { size?: unknown }).size === 'number' &&
      Array.isArray((f as { chunks?: unknown }).chunks),
  );
}
