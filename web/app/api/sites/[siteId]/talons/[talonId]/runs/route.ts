/**
 * GET /api/sites/{siteId}/talons/{talonId}/runs
 *   output: { runs: TalonRun[], next_page_token, nextPageToken }
 *
 * Cursor-paginated execution history for one talon, most recent first, read
 * from `sites/{siteId}/talon_runs` filtered by `talonId`. The composite index
 * (`talonId` ASC, `startedAt` DESC) is declared in firestore.indexes.json.
 *
 * The talon is NOT required to still exist: run records are an audit surface
 * and deliberately outlive the talon they describe (see `deleteTalon`), so a
 * missing talon returns an empty page rather than 404.
 *
 * The collection stays empty until the runner ships in wave 2.
 *
 * Capability: TALON_MANAGE with read-class api-key scope (`site=<siteId>:read`).
 *
 * talons wave 1.2.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { problemFromError, problemValidation } from '@/lib/apiErrors';
import {
  authorizedSiteHandler,
  type SiteHandlerContext,
} from '@/lib/authorizedHandler.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { timestampToIso } from '@/lib/firestoreTime.server';
import {
  collectFilteredPage,
  parsePagination,
  withPaginationFields,
} from '@/lib/pagination';

export const runtime = 'nodejs';

/** Matches the item route's bound — its job is rejecting path-escaping ids. */
const TALON_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

type RouteParams = { siteId: string; talonId: string };
type RouteContext = { params: Promise<RouteParams> };

export const GET = authorizedSiteHandler<RouteParams>({
  capability: 'TALON_MANAGE',
  siteIdParam: 'path',
  targetKind: 'talon',
  targetIdParam: 'talonId',
  apiKeyPermission: 'read',
})(async (request: NextRequest, ctx: SiteHandlerContext, routeContext: RouteContext) => {
  try {
    const { talonId } = await routeContext.params;
    if (!TALON_ID_RE.test(talonId)) {
      return problemValidation('invalid talon id', {
        'path.talonId': ['must be 1-128 chars: letters, digits, underscore, hyphen'],
      });
    }

    const parsedPagination = parsePagination(request.nextUrl.searchParams, {
      defaultPageSize: DEFAULT_PAGE_SIZE,
      maxPageSize: MAX_PAGE_SIZE,
    });
    if (!parsedPagination.ok) return parsedPagination.response;
    const { pageSize, pageToken } = parsedPagination.pagination;

    const runsCollection = getAdminDb()
      .collection('sites')
      .doc(ctx.siteId)
      .collection('talon_runs');

    const page = await collectFilteredPage({
      pageSize,
      pageToken,
      fetchPage: async (cursor, limit) => {
        let query = runsCollection
          .where('talonId', '==', talonId)
          .orderBy('startedAt', 'desc')
          .limit(limit);
        if (cursor) {
          const cursorSnapshot = await runsCollection.doc(cursor).get();
          if (cursorSnapshot.exists) query = query.startAfter(cursorSnapshot);
        }
        const snapshot = await query.get();
        return snapshot.docs;
      },
      // The query is already exact — every doc it returns belongs on the page.
      include: () => true,
    });

    const runs = page.docs.map((doc) => serializeRun(doc.id, doc.data()));
    return NextResponse.json(withPaginationFields({ runs }, page.nextPageToken));
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/talons/[talonId]/runs:GET');
  }
});

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Wire form of a run record. Timestamps become ISO-8601 strings and every
 * optional field becomes an explicit `null`, so a client rendering the run
 * list never has to distinguish "absent" from "not applicable".
 */
function serializeRun(id: string, data: FirebaseFirestore.DocumentData) {
  return {
    id,
    talonId: stringOrNull(data.talonId) ?? '',
    talonName: stringOrNull(data.talonName) ?? '',
    triggerType: stringOrNull(data.triggerType),
    triggerSummary: stringOrNull(data.triggerSummary),
    machineId: stringOrNull(data.machineId),
    machineName: stringOrNull(data.machineName),
    status: stringOrNull(data.status) ?? 'running',
    startedAt: timestampToIso(data.startedAt),
    completedAt: timestampToIso(data.completedAt),
    durationMs: typeof data.durationMs === 'number' ? data.durationMs : null,
    condition: data.condition ?? null,
    outputs: Array.isArray(data.outputs) ? data.outputs : [],
    correlationId: stringOrNull(data.correlationId),
    chatId: stringOrNull(data.chatId),
    error: stringOrNull(data.error),
    manual: data.manual === true,
  };
}
