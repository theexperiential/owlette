/**
 * GET /api/sites/{siteId}/audit-log?kind=&actor=&since=&limit=50&cursor=
 *     → List audit records for a site, newest first. Cursor-paginated.
 *
 * Filters:
 *   kind    — event kind (signed_url_issued, api_key_used, etc.)
 *   actor   — actor string (e.g. `apiKey:<keyId>` or a uid)
 *   since   — iso8601 or unix-ms. Records with recordedAt >= since.
 *
 * kind + actor are applied client-side after the range + order query so
 * we don't require composite firestore indexes per-filter. For tight
 * paginated use cases this means callers may see fewer than `limit`
 * rows per page when filters match rarely.
 *
 * roost public api wave 3.8.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { Timestamp } from 'firebase-admin/firestore';
import { timestampToMs } from '@/lib/firestoreTime.server';
import {
  problemFromError,
  problemValidation,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  applyAuthDeprecations,
  requireSiteAuthAndScope,
} from '../../../_shared';

interface RouteParams {
  params: Promise<{ siteId: string }>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId } = await params;
    const auth = await requireSiteAuthAndScope(request, siteId, 'read');
    if (!auth.ok) return auth.response;

    const qp = request.nextUrl.searchParams;
    const kindFilter = qp.get('kind');
    const actorFilter = qp.get('actor');
    const sinceRaw = qp.get('since');
    const limitRaw = Number(qp.get('limit') ?? DEFAULT_LIMIT);
    const limit = Math.min(
      Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : DEFAULT_LIMIT),
      MAX_LIMIT,
    );
    const cursor = qp.get('cursor');

    let sinceMs: number | undefined;
    if (sinceRaw) {
      // Accept unix-ms OR iso8601
      const asNumber = Number(sinceRaw);
      if (Number.isFinite(asNumber) && asNumber > 0) {
        sinceMs = asNumber;
      } else {
        const parsed = Date.parse(sinceRaw);
        if (Number.isNaN(parsed)) {
          return problemValidation('since must be unix-ms or iso8601', {
            'query.since': ['invalid date'],
          });
        }
        sinceMs = parsed;
      }
    }

    const db = getAdminDb();
    const col = db
      .collection('sites')
      .doc(siteId)
      .collection('audit_log');

    // Client-side filter step may drop rows — over-fetch by 3x when filters
    // are supplied so the page has a reasonable chance of filling to `limit`.
    const hasClientFilter = !!(kindFilter || actorFilter);
    const fetchLimit = hasClientFilter ? limit * 3 + 1 : limit + 1;

    let query = col.orderBy('recordedAt', 'desc').limit(fetchLimit);
    if (typeof sinceMs === 'number') {
      query = col
        .where('recordedAt', '>=', sinceMs)
        .orderBy('recordedAt', 'desc')
        .limit(fetchLimit);
    }
    if (cursor) {
      const cursorSnap = await col.doc(cursor).get();
      if (cursorSnap.exists) query = query.startAfter(cursorSnap);
    }

    const snap = await query.get();

    type Row = {
      hash: string;
      kind: string;
      actor: string;
      siteId: string;
      occurredAt: number | null;
      recordedAt: number | null;
      attributes: Record<string, unknown>;
    };

    const allRows: Row[] = snap.docs.map((d) => {
      const data = d.data() as {
        event?: {
          kind?: string;
          siteId?: string;
          actor?: string;
          occurredAt?: number;
          attributes?: Record<string, unknown>;
        };
        recordedAt?: number | Timestamp;
      };
      const evt = data.event ?? {};
      return {
        hash: d.id,
        kind: typeof evt.kind === 'string' ? evt.kind : 'unknown',
        actor: typeof evt.actor === 'string' ? evt.actor : '',
        siteId: typeof evt.siteId === 'string' ? evt.siteId : siteId,
        occurredAt: typeof evt.occurredAt === 'number' ? evt.occurredAt : null,
        recordedAt: timestampToMs(data.recordedAt),
        attributes: evt.attributes && typeof evt.attributes === 'object' ? evt.attributes : {},
      };
    });

    const filtered = allRows.filter((r) => {
      if (kindFilter && r.kind !== kindFilter) return false;
      if (actorFilter && r.actor !== actorFilter) return false;
      return true;
    });

    const page = filtered.slice(0, limit);
    // nextPageToken: if we hit the over-fetch cap (last raw row exists
    // beyond the filtered page), carry forward the last raw row's hash as
    // the cursor. This keeps pagination correct when filters drop rows.
    const sawMoreRaw = snap.docs.length === fetchLimit;
    const lastRawHash = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1].id : '';
    const nextPageToken = sawMoreRaw ? lastRawHash : filtered.length > limit ? page[page.length - 1].hash : '';

    return applyAuthDeprecations(
      NextResponse.json({
        siteId,
        records: page,
        nextPageToken,
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'v2/sites/[siteId]/audit-log:GET');
  }
}
