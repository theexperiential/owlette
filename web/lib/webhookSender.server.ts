/**
 * Webhook dispatch utility for Owlette.
 *
 * Fires JSON payloads to all enabled webhooks for a site that subscribe to a
 * given event type.  Non-blocking — uses Promise.allSettled and never throws.
 *
 * Each delivery includes an HMAC-SHA256 signature in the X-Owlette-Signature
 * header so receivers can verify authenticity.
 *
 * Auto-disables webhooks after 10 consecutive delivery failures.
 */

import { getAdminDb } from '@/lib/firebase-admin';
import crypto from 'crypto';

export interface WebhookPayload {
  event: string;
  timestamp: string;
  site: { id: string; name: string };
  data: Record<string, unknown>;
}

/**
 * Fire all enabled webhooks for a site that subscribe to the given event.
 * Non-blocking — uses Promise.allSettled, never throws.
 *
 * @returns The number of webhooks that were successfully delivered.
 */
export async function fireWebhooks(
  siteId: string,
  siteName: string,
  eventType: string,
  data: Record<string, unknown>
): Promise<number> {
  const db = getAdminDb();

  // Query enabled webhooks that subscribe to this event
  const snapshot = await db
    .collection(`sites/${siteId}/webhooks`)
    .where('enabled', '==', true)
    .where('events', 'array-contains', eventType)
    .get();

  if (snapshot.empty) return 0;

  const payload: WebhookPayload = {
    event: eventType,
    timestamp: new Date().toISOString(),
    site: { id: siteId, name: siteName },
    data,
  };

  const body = JSON.stringify(payload);
  let successCount = 0;

  const deliveries = snapshot.docs.map(async (doc) => {
    const webhook = doc.data();
    try {
      // HMAC signature
      const signature = crypto
        .createHmac('sha256', webhook.secret)
        .update(body)
        .digest('hex');

      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Owlette-Signature': `sha256=${signature}`,
          'X-Owlette-Event': eventType,
          'User-Agent': 'Owlette-Webhooks/1.0',
        },
        body,
        signal: AbortSignal.timeout(5000),
      });

      const newFailCount = response.ok ? 0 : (webhook.failCount || 0) + 1;

      // Update delivery status
      await doc.ref.update({
        lastTriggered: new Date(),
        lastStatus: response.status,
        failCount: newFailCount,
        ...(newFailCount >= 10 ? { enabled: false } : {}),
      });

      if (newFailCount >= 10) {
        console.warn(`[webhooks] Webhook ${doc.id} auto-disabled after 10 consecutive failures`);
      }

      if (response.ok) successCount++;
    } catch (error) {
      const newFailCount = (webhook.failCount || 0) + 1;

      await doc.ref.update({
        lastTriggered: new Date(),
        lastStatus: 0, // network error
        failCount: newFailCount,
        ...(newFailCount >= 10 ? { enabled: false } : {}),
      });

      if (newFailCount >= 10) {
        console.warn(`[webhooks] Webhook ${doc.id} auto-disabled after 10 consecutive failures`);
      }
    }
  });

  await Promise.allSettled(deliveries);
  return successCount;
}

/**
 * Send a test payload to a specific webhook. Returns the HTTP status code
 * or 0 on network error.
 */
export async function testWebhook(
  url: string,
  secret: string
): Promise<{ status: number; error?: string }> {
  const payload: WebhookPayload = {
    event: 'test',
    timestamp: new Date().toISOString(),
    site: { id: 'test', name: 'Test' },
    data: { message: 'This is a test webhook from Owlette.' },
  };

  const body = JSON.stringify(payload);
  const signature = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Owlette-Signature': `sha256=${signature}`,
        'X-Owlette-Event': 'test',
        'User-Agent': 'Owlette-Webhooks/1.0',
      },
      body,
      signal: AbortSignal.timeout(10000),
    });

    return { status: response.status };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Network error';
    return { status: 0, error: message };
  }
}
