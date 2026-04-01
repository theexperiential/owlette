import { NextRequest, NextResponse } from 'next/server';
import { ApiAuthError, requireAdmin } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { testWebhook } from '@/lib/webhookSender.server';

/**
 * POST /api/webhooks/test
 *
 * Sends a test payload to a webhook URL. Requires admin session.
 *
 * Body: { webhookId: string, siteId: string }
 *
 * Response: { success: boolean, status: number, error?: string }
 */
export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request);
    const { webhookId, siteId } = await request.json();

    if (!webhookId || !siteId) {
      return NextResponse.json(
        { error: 'Missing required fields: webhookId, siteId' },
        { status: 400 }
      );
    }

    const db = getAdminDb();
    const webhookDoc = await db
      .collection(`sites/${siteId}/webhooks`)
      .doc(webhookId)
      .get();

    if (!webhookDoc.exists) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 });
    }

    const webhook = webhookDoc.data()!;
    const result = await testWebhook(webhook.url, webhook.secret);

    // Update last triggered
    await webhookDoc.ref.update({
      lastTriggered: new Date(),
      lastStatus: result.status,
    });

    return NextResponse.json({
      success: result.status >= 200 && result.status < 300,
      status: result.status,
      error: result.error,
    });
  } catch (error: unknown) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[webhooks/test] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
