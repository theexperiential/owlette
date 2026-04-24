/**
 * Webhook subscription management (wave 6 endpoints). Methods are
 * forward-declared now so callers can write code against the final
 * shape — they'll 404 until wave 6.1 ships the server routes.
 */
import type { RoostClient } from '../lib/client';

export interface WebhookSubscription {
  id: string;
  url: string;
  events: string[];
  description?: string;
  createdAt?: string | null;
  paused?: boolean;
  lastDeliveryAt?: string | null;
  failureCount?: number;
}

export class Webhooks {
  constructor(private readonly client: RoostClient) {}

  async subscribe(
    siteId: string,
    url: string,
    events: readonly string[],
    description?: string,
  ): Promise<{ id: string; signingSecret: string }> {
    const res = await this.client.request<{ id: string; signingSecret: string }>(
      '/api/webhooks',
      {
        method: 'POST',
        query: { siteId },
        body: { url, events, description },
      },
    );
    return res.data;
  }

  async list(siteId: string): Promise<WebhookSubscription[]> {
    const res = await this.client.request<{ webhooks: WebhookSubscription[] }>(
      '/api/webhooks',
      { query: { siteId } },
    );
    return res.data.webhooks;
  }

  async get(webhookId: string, siteId: string): Promise<WebhookSubscription> {
    const res = await this.client.request<WebhookSubscription>(
      `/api/webhooks/${encodeURIComponent(webhookId)}`,
      { query: { siteId } },
    );
    return res.data;
  }

  async update(
    webhookId: string,
    siteId: string,
    patch: { url?: string; events?: string[]; paused?: boolean },
  ): Promise<WebhookSubscription> {
    const res = await this.client.request<WebhookSubscription>(
      `/api/webhooks/${encodeURIComponent(webhookId)}`,
      { method: 'PATCH', query: { siteId }, body: patch },
    );
    return res.data;
  }

  async remove(webhookId: string, siteId: string): Promise<void> {
    await this.client.request<void>(`/api/webhooks/${encodeURIComponent(webhookId)}`, {
      method: 'DELETE',
      query: { siteId },
    });
  }

  async rotateSecret(webhookId: string, siteId: string): Promise<{ signingSecret: string }> {
    const res = await this.client.request<{ signingSecret: string }>(
      `/api/webhooks/${encodeURIComponent(webhookId)}/rotate-secret`,
      { method: 'POST', query: { siteId } },
    );
    return res.data;
  }

  async probe(siteId: string, kind: string, payload: Record<string, unknown>): Promise<unknown> {
    const res = await this.client.request<unknown>('/api/webhooks/probe', {
      method: 'POST',
      body: { siteId, kind, payload },
    });
    return res.data;
  }
}
