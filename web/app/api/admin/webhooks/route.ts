import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import {
  authorizedLegacyBodySiteHandler,
  authorizedSiteHandler,
  type SiteHandlerContext,
} from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { apiError } from '@/lib/apiErrorResponse';

const LEGACY_ADMIN_SUNSET = 'Wed, 30 Sep 2026 00:00:00 GMT';

/**
 * GET /api/admin/webhooks?siteId=xxx
 *
 * List all webhooks for a site.
 *
 * POST /api/admin/webhooks
 * Body: { siteId, name, url, events[] }
 *
 * Create a new webhook. Auto-generates HMAC secret.
 *
 * DELETE /api/admin/webhooks?siteId=xxx&webhookId=yyy
 *
 * Delete a webhook.
 */
export const GET = authorizedSiteHandler({
  capability: Capability.WEBHOOK_MANAGE,
  siteIdParam: 'query',
  targetKind: 'site',
  apiKeyPermission: 'read',
  deprecated: true,
  canonicalUrl: '/api/sites/{siteId}/webhooks',
  sunsetDate: LEGACY_ADMIN_SUNSET,
  routeName: 'GET /api/admin/webhooks',
})(async function GET(request: NextRequest) {
  try {
    const siteId = request.nextUrl.searchParams.get('siteId');
    if (!siteId) {
      return NextResponse.json({ error: 'Missing siteId' }, { status: 400 });
    }

    const db = getAdminDb();
    const snap = await db.collection(`sites/${siteId}/webhooks`).get();
    const webhooks = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
      lastTriggered: doc.data().lastTriggered?.toDate?.()?.toISOString() || null,
      createdAt: doc.data().createdAt?.toDate?.()?.toISOString() || null,
    }));

    return NextResponse.json({ success: true, webhooks });
  } catch (error: unknown) {
    return apiError(error, 'admin/webhooks GET');
  }
});

export const POST = authorizedLegacyBodySiteHandler({
  capability: Capability.WEBHOOK_MANAGE,
  targetKind: 'site',
  deprecated: true,
  canonicalUrl: '/api/sites/{siteId}/webhooks',
  sunsetDate: LEGACY_ADMIN_SUNSET,
  routeName: 'POST /api/admin/webhooks',
})(async function POST(request: NextRequest, ctx: SiteHandlerContext) {
  try {
    const body = await request.json();
    const { siteId, name, url, events } = body;

    if (!siteId || !name || !url) {
      return NextResponse.json({ error: 'Missing required fields: siteId, name, url' }, { status: 400 });
    }

    if (!url.startsWith('https://')) {
      return NextResponse.json({ error: 'URL must start with https://' }, { status: 400 });
    }

    if (!Array.isArray(events) || events.length === 0) {
      return NextResponse.json({ error: 'events must be a non-empty array' }, { status: 400 });
    }

    const db = getAdminDb();
    const secret = crypto.randomBytes(32).toString('hex');

    const ref = await db.collection(`sites/${siteId}/webhooks`).add({
      url,
      name,
      events,
      enabled: true,
      secret,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: ctx.actor.userId,
      lastTriggered: null,
      lastStatus: 0,
      failCount: 0,
    });

    return NextResponse.json({ success: true, webhookId: ref.id, secret });
  } catch (error: unknown) {
    return apiError(error, 'admin/webhooks POST');
  }
});

export const DELETE = authorizedSiteHandler({
  capability: Capability.WEBHOOK_MANAGE,
  siteIdParam: 'query',
  targetKind: 'site',
  deprecated: true,
  canonicalUrl: '/api/sites/{siteId}/webhooks/{webhookId}',
  sunsetDate: LEGACY_ADMIN_SUNSET,
  routeName: 'DELETE /api/admin/webhooks',
})(async function DELETE(request: NextRequest) {
  try {
    const siteId = request.nextUrl.searchParams.get('siteId');
    const webhookId = request.nextUrl.searchParams.get('webhookId');

    if (!siteId || !webhookId) {
      return NextResponse.json({ error: 'Missing siteId or webhookId' }, { status: 400 });
    }

    const db = getAdminDb();
    await db.collection(`sites/${siteId}/webhooks`).doc(webhookId).delete();

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    return apiError(error, 'admin/webhooks DELETE');
  }
});
