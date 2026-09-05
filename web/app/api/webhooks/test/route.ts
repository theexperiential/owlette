import { NextRequest, NextResponse } from 'next/server';
import { ApiAuthError } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { readWebhookSecrets } from '@/lib/webhookSecrets.server';
import { FieldValue } from 'firebase-admin/firestore';
import { testWebhook } from '@/lib/webhookSender.server';
import { apiError } from '@/lib/apiErrorResponse';
import {
  requireSiteAuthAndScope,
  requireWebhookManageCapability,
} from '../../_shared';

/**
 * POST /api/webhooks/test
 *
 * Sends a test payload to a webhook URL.
 *
 * Body: { webhookId: string, siteId: string }
 *
 * Auth: site membership + `WEBHOOK_MANAGE` on that site (site admins and
 * superadmins), matching the other mutating webhook routes. It was superadmin-
 * only, which locked site admins out of testing their own subscriptions. The
 * siteId comes from the body, as it always has — the same value is what both the
 * authorization and the document read are keyed on, so the two cannot diverge.
 * api-key callers additionally need `site=<siteId>:write`.
 *
 * Response: { success: boolean, status: number, error?: string }
 */
export async function POST(request: NextRequest) {
  try {
    const { webhookId, siteId } = await request.json();

    if (!webhookId || !siteId) {
      return NextResponse.json(
        { error: 'Missing required fields: webhookId, siteId' },
        { status: 400 }
      );
    }

    const auth = await requireSiteAuthAndScope(request, siteId, 'write');
    if (!auth.ok) return auth.response;

    const capabilityError = await requireWebhookManageCapability(auth.auth, siteId);
    if (capabilityError) return capabilityError;

    const db = getAdminDb();
    const webhookDoc = await db
      .collection(`sites/${siteId}/webhooks`)
      .doc(webhookId)
      .get();

    if (!webhookDoc.exists) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 });
    }

    const webhook = webhookDoc.data()!;
    // Secrets live in the server-only sibling; the legacy in-document fields are
    // the fallback for subscriptions that predate the migration.
    const stored = await readWebhookSecrets(siteId, webhookId);
    const signingSecret =
      stored.signingSecret ??
      (typeof webhook.signingSecret === 'string' ? webhook.signingSecret : webhook.secret);
    const result = await testWebhook(webhook.url, signingSecret);

    // Update last triggered
    await webhookDoc.ref.update({
      lastTriggered: FieldValue.serverTimestamp(),
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
    return apiError(error, 'webhooks/test');
  }
}
