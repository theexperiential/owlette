/**
 * GET /api/webhooks/{webhookId}/deliveries?siteId=...&limit=&cursor=
 *   output: { deliveries: DeliverySummary[], nextPageToken }
 *
 *   - cursor-paginated, most recent first
 *   - scoped to the last 30 days (matches the dispatcher retention
 *     documented in docs/api/webhooks.md)
 *   - caller must have `site:<id>:read`
 *   - 404 if the webhook subscription doesn't exist or is soft-deleted
 *
 * Underlying store is the top-level `webhook_deliveries` collection
 * populated by the scheduled dispatcher (functions/webhookDispatch.ts).
 * We query by `subscriptionId == webhookId`. Firestore will prompt for
 * a composite index (`subscriptionId` + `createdAt desc`) on first run —
 * surface that error to the user unchanged so ops can click through to
 * create it.
 *
 * roost public api wave 6.6.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import {
  problemFromError,
  problemNotFound,
  problemValidation,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';

import {
  applyAuthDeprecations,
  requireSiteAuthAndScope,
  validateSiteIdBody,
} from '../../../_shared';

export const runtime = 'nodejs';

const WEBHOOK_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DELIVERIES_COLLECTION = 'webhook_deliveries';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ webhookId: string }> },
) {
  try {
    const { webhookId } = await params;
    if (!WEBHOOK_ID_RE.test(webhookId)) {
      return problemValidation(
        'webhookId must be 8-64 chars: letters, digits, underscore, hyphen',
        { 'path.webhookId': ['invalid format'] },
      );
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

    const db = getAdminDb();

    // Confirm the subscription exists + belongs to this site before
    // exposing its delivery history. (We don't reveal whether a
    // subscription id is valid on another site.)
    const webhookRef = db
      .collection('sites')
      .doc(site.siteId)
      .collection('webhooks')
      .doc(webhookId);
    const webhookSnap = await webhookRef.get();
    const webhookData = webhookSnap.data();
    if (!webhookSnap.exists || !webhookData || webhookData.deletedAt) {
      return problemNotFound(`webhook ${webhookId} not found on site ${site.siteId}`);
    }

    const limitRaw = Number(
      request.nextUrl.searchParams.get('limit') ?? DEFAULT_LIST_LIMIT,
    );
    const limit = Math.min(
      Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : DEFAULT_LIST_LIMIT),
      MAX_LIST_LIMIT,
    );
    const cursor = request.nextUrl.searchParams.get('cursor');

    const windowStart = Date.now() - HISTORY_WINDOW_MS;
    const base = db
      .collection(DELIVERIES_COLLECTION)
      .where('subscriptionId', '==', webhookId)
      .where('createdAt', '>=', windowStart)
      .orderBy('createdAt', 'desc');

    let query = base.limit(limit + 1);
    if (cursor) {
      const cursorSnap = await db.collection(DELIVERIES_COLLECTION).doc(cursor).get();
      if (cursorSnap.exists) query = query.startAfter(cursorSnap);
    }

    const snap = await query.get();
    const overflow = snap.docs.length > limit;
    const pageDocs = overflow ? snap.docs.slice(0, limit) : snap.docs;
    const nextPageToken = overflow ? (snap.docs[limit]?.id ?? '') : '';

    const deliveries = pageDocs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        event: typeof data.event === 'string' ? data.event : null,
        state:
          typeof data.state === 'string'
            ? (data.state as 'pending' | 'succeeded' | 'failed')
            : 'pending',
        attempt: typeof data.attempt === 'number' ? data.attempt : 0,
        lastStatus: typeof data.lastStatus === 'number' ? data.lastStatus : null,
        lastError: typeof data.lastError === 'string' ? data.lastError : null,
        createdAt: msToIso(data.createdAt),
        completedAt: msToIso(data.completedAt),
        nextAttemptAt:
          data.state === 'pending' ? msToIso(data.nextAttemptAt) : null,
      };
    });

    return applyAuthDeprecations(
      NextResponse.json({ deliveries, nextPageToken }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'webhooks/[webhookId]/deliveries:GET');
  }
}

function msToIso(v: unknown): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return new Date(v).toISOString();
}
