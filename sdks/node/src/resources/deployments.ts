import type { RoostClient } from '../lib/client';

export class Deployments {
  constructor(private readonly client: RoostClient) {}

  async list(
    roostId: string,
    opts: { siteId: string; limit?: number; cursor?: string },
  ): Promise<{ rollouts: Array<Record<string, unknown>>; nextPageToken: string }> {
    const res = await this.client.request<{
      rollouts: Array<Record<string, unknown>>;
      nextPageToken: string;
    }>(`/api/roosts/${encodeURIComponent(roostId)}/deployments`, {
      query: { siteId: opts.siteId, limit: opts.limit, cursor: opts.cursor },
    });
    return res.data;
  }

  async get(
    roostId: string,
    rolloutId: string,
    opts: { siteId: string },
  ): Promise<Record<string, unknown>> {
    const res = await this.client.request<Record<string, unknown>>(
      `/api/roosts/${encodeURIComponent(roostId)}/deployments/${encodeURIComponent(rolloutId)}`,
      { query: { siteId: opts.siteId } },
    );
    return res.data;
  }
}
