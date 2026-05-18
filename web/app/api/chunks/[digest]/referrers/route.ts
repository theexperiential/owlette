/**
 * GET /api/chunks/{digest}/referrers?siteId=...&limit=50&cursor=...
 *
 * List recorded referrers of a chunk. Today this surfaces entries written
 * by `POST /mount`; a future wave will also write entries on every
 * version publish so this becomes the complete referrer index.
 *
 * roost public api wave 3.4.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problemFromError,
  problemValidation,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { timestampToIso } from '@/lib/firestoreTime.server';
import { gateOrProceed } from '@/lib/roostKillSwitch';
import {
  nextPageTokenFromDocs,
  parsePagination,
  withPaginationFields,
} from '@/lib/pagination';
import {
  applyAuthDeprecations,
  requireSiteAuthAndScope,
  validateSiteIdBody,
} from '../../../_shared';

interface RouteParams {
  params: Promise<{ digest: string }>;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

async function readSiteDocForGate(siteId: string): Promise<Record<string, unknown> | null> {
  const snap = await getAdminDb().collection('sites').doc(siteId).get();
  return snap.exists ? (snap.data() ?? null) : null;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { digest } = await params;
    if (!SHA256_HEX_RE.test(digest)) {
      return problemValidation('digest must be a 64-char lowercase sha-256 hex', {
        digest: ['must match ^[0-9a-f]{64}$'],
      });
    }

    const siteIdParam = request.nextUrl.searchParams.get('siteId');
    if (!siteIdParam) {
      return problemValidation('query param `siteId` is required', {
        'query.siteId': ['required'],
      });
    }
    const site = validateSiteIdBody(siteIdParam, 'query.siteId');
    if (!site.ok) return site.response;

    const auth = await requireSiteAuthAndScope(request, site.siteId, 'read');
    if (!auth.ok) return auth.response;

    const gateRes = await gateOrProceed(site.siteId, readSiteDocForGate);
    if (gateRes) return gateRes;

    const parsedPagination = parsePagination(request.nextUrl.searchParams, {
      defaultPageSize: DEFAULT_LIMIT,
      maxPageSize: MAX_LIMIT,
    });
    if (!parsedPagination.ok) return parsedPagination.response;
    const { pageSize, pageToken } = parsedPagination.pagination;

    const db = getAdminDb();
    const entriesCol = db
      .collection('sites')
      .doc(site.siteId)
      .collection('chunk_referrers')
      .doc(digest)
      .collection('entries');

    let query = entriesCol.orderBy('mountedAt', 'desc').limit(pageSize + 1);
    if (pageToken) {
      const cursorSnap = await entriesCol.doc(pageToken).get();
      if (cursorSnap.exists) query = query.startAfter(cursorSnap);
    }

    const snap = await query.get();
    const docs = snap.docs.slice(0, pageSize);
    const nextPageToken = nextPageTokenFromDocs(snap.docs, pageSize);

    const referrers = docs.map((d) => {
      const data = d.data();
      return {
        entryId: d.id,
        source: typeof data.source === 'string' ? data.source : 'mount',
        roostId: data.roostId ?? null,
        fromRoostId: data.fromRoostId ?? null,
        toRoostId: data.toRoostId ?? null,
        versionId: data.versionId ?? null,
        versionNumber:
          typeof data.versionNumber === 'number' ? data.versionNumber : null,
        fileCount:
          typeof data.fileCount === 'number'
            ? data.fileCount
            : typeof data.pathCount === 'number'
              ? data.pathCount
              : null,
        pathCount:
          typeof data.pathCount === 'number'
            ? data.pathCount
            : typeof data.fileCount === 'number'
              ? data.fileCount
              : null,
        totalBytes: typeof data.totalBytes === 'number' ? data.totalBytes : null,
        referencedAt: timestampToIso(data.referencedAt ?? data.mountedAt ?? data.createdAt),
        createdAt: timestampToIso(data.createdAt),
        createdBy: data.createdBy ?? null,
        mountedAt: timestampToIso(data.mountedAt),
        mountedBy: data.mountedBy ?? null,
      };
    });

    return applyAuthDeprecations(
      NextResponse.json(
        withPaginationFields(
          {
            digest,
            siteId: site.siteId,
            referrers,
            items: referrers,
          },
          nextPageToken,
        ),
      ),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/chunks/[digest]/referrers:GET');
  }
}
