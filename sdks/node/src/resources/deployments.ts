import type { OwletteClient } from '../lib/client';

export interface ListDeploymentsOptions {
  siteId: string;
  /** Deprecated alias for pageSize; use pageSize for new code. */
  limit?: number;
  /** Deprecated alias for pageToken; use pageToken for new code. */
  cursor?: string;
  pageSize?: number;
  pageToken?: string;
}

export class Deployments {
  constructor(private readonly client: OwletteClient) {}

  async list(
    roostId: string,
    opts: ListDeploymentsOptions,
  ): Promise<{ rollouts: Array<Record<string, unknown>>; nextPageToken: string }> {
    const res = await this.client.request<{
      rollouts: Array<Record<string, unknown>>;
      nextPageToken: string;
    }>(`/api/roosts/${encodeURIComponent(roostId)}/deployments`, {
      query: {
        siteId: opts.siteId,
        page_size: opts.pageSize ?? opts.limit,
        page_token: opts.pageToken ?? opts.cursor,
      },
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
