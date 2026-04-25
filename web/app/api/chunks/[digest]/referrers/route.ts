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

    const limitRaw = Number(request.nextUrl.searchParams.get('limit') ?? DEFAULT_LIMIT);
    const limit = Math.min(
      Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : DEFAULT_LIMIT),
      MAX_LIMIT,
    );
    const cursor = request.nextUrl.searchParams.get('cursor');

    const db = getAdminDb();
    const entriesCol = db
      .collection('sites')
      .doc(site.siteId)
      .collection('chunk_referrers')
      .doc(digest)
      .collection('entries');

    let query = entriesCol.orderBy('mountedAt', 'desc').limit(limit + 1);
    if (cursor) {
      const cursorSnap = await entriesCol.doc(cursor).get();
      if (cursorSnap.exists) query = query.startAfter(cursorSnap);
    }

    const snap = await query.get();
    const docs = snap.docs.slice(0, limit);
    const nextPageToken = snap.docs.length > limit ? snap.docs[limit].id : '';

    const referrers = docs.map((d) => {
      const data = d.data();
      return {
        entryId: d.id,
        source: typeof data.source === 'string' ? data.source : 'mount',
        fromRoostId: data.fromRoostId ?? null,
        toRoostId: data.toRoostId ?? null,
        versionId: data.versionId ?? null,
        mountedAt: timestampToIso(data.mountedAt),
        mountedBy: data.mountedBy ?? null,
      };
    });

    return applyAuthDeprecations(
      NextResponse.json({
        digest,
        siteId: site.siteId,
        referrers,
        nextPageToken,
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/chunks/[digest]/referrers:GET');
  }
}
