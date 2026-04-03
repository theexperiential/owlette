import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { ApiAuthError, requireAdminOrIdToken, assertUserHasSiteAccess } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';

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
export async function GET(request: NextRequest) {
  try {
    const userId = await requireAdminOrIdToken(request);
    const siteId = request.nextUrl.searchParams.get('siteId');
    if (!siteId) {
      return NextResponse.json({ error: 'Missing siteId' }, { status: 400 });
    }

    await assertUserHasSiteAccess(userId, siteId);

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
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const userId = await requireAdminOrIdToken(request);
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

    await assertUserHasSiteAccess(userId, siteId);

    const db = getAdminDb();
    const secret = crypto.randomBytes(32).toString('hex');

    const ref = await db.collection(`sites/${siteId}/webhooks`).add({
      url,
      name,
      events,
      enabled: true,
      secret,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: userId,
      lastTriggered: null,
      lastStatus: 0,
      failCount: 0,
    });

    return NextResponse.json({ success: true, webhookId: ref.id, secret });
  } catch (error: unknown) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('admin/webhooks POST:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const userId = await requireAdminOrIdToken(request);
    const siteId = request.nextUrl.searchParams.get('siteId');
    const webhookId = request.nextUrl.searchParams.get('webhookId');

    if (!siteId || !webhookId) {
      return NextResponse.json({ error: 'Missing siteId or webhookId' }, { status: 400 });
    }

    await assertUserHasSiteAccess(userId, siteId);

    const db = getAdminDb();
    await db.collection(`sites/${siteId}/webhooks`).doc(webhookId).delete();

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
