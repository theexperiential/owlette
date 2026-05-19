import type { OwletteClient } from '../lib/client';

export interface WebhookSubscription {
  id: string;
  url: string;
  events: string[];
  description?: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  paused?: boolean;
  lastDeliveryAt?: string | null;
  lastDeliveryStatus?: string | null;
  failureCount?: number;
}

export interface WebhookDelivery {
  id: string;
  webhookId?: string;
  siteId?: string;
  event: string | null;
  state: 'pending' | 'succeeded' | 'failed';
  attempt: number;
  lastStatus?: number | null;
  lastError?: string | null;
  createdAt: string | null;
  completedAt?: string | null;
  nextAttemptAt: string | null;
  request?: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string;
  };
  response?: {
    status: number;
    headers: Record<string, string>;
    body: string;
    durationMs: number | null;
  } | null;
}

export interface ListWebhookDeliveriesResult {
  deliveries: WebhookDelivery[];
  nextPageToken: string;
  next_page_token: string;
}

export interface ProbeWebhookOptions {
  url: string;
  payload?: Record<string, unknown>;
  signingSecret?: string;
}

export class Webhooks {
  constructor(private readonly client: OwletteClient) {}

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
    patch: { url?: string; events?: string[]; description?: string | null; paused?: boolean },
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
      { method: 'POST', query: { siteId }, body: {} },
    );
    return res.data;
  }

  async deliveries(
    webhookId: string,
    siteId: string,
    opts: { pageSize?: number; pageToken?: string } = {},
  ): Promise<ListWebhookDeliveriesResult> {
    const res = await this.client.request<ListWebhookDeliveriesResult>(
      `/api/webhooks/${encodeURIComponent(webhookId)}/deliveries`,
      {
        query: {
          siteId,
          page_size: opts.pageSize,
          page_token: opts.pageToken,
        },
      },
    );
    return res.data;
  }

  async delivery(
    webhookId: string,
    deliveryId: string,
    siteId: string,
  ): Promise<WebhookDelivery> {
    const res = await this.client.request<WebhookDelivery>(
      `/api/webhooks/${encodeURIComponent(webhookId)}/deliveries/${encodeURIComponent(deliveryId)}`,
      { query: { siteId } },
    );
    return res.data;
  }

  async retryDelivery(
    webhookId: string,
    deliveryId: string,
    siteId: string,
  ): Promise<{
    id: string;
    webhookId: string;
    siteId: string;
    retryOf: string;
    state: 'pending';
    nextAttemptAt: string;
  }> {
    const res = await this.client.request<{
      id: string;
      webhookId: string;
      siteId: string;
      retryOf: string;
      state: 'pending';
      nextAttemptAt: string;
    }>(
      `/api/webhooks/${encodeURIComponent(webhookId)}/deliveries/${encodeURIComponent(deliveryId)}/retry`,
      { method: 'POST', query: { siteId }, body: {} },
    );
    return res.data;
  }

  async probe(
    siteId: string,
    event: string,
    options: ProbeWebhookOptions,
  ): Promise<unknown> {
    const res = await this.client.request<unknown>('/api/webhooks/probe', {
      method: 'POST',
      query: { siteId },
      body: {
        url: options.url,
        event,
        payload: options.payload,
        signingSecret: options.signingSecret,
      },
    });
    return res.data;
  }
}
