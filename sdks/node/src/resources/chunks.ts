import type { RoostClient } from '../lib/client';

export class Chunks {
  constructor(private readonly client: RoostClient) {}

  async check(siteId: string, hashes: readonly string[]): Promise<string[]> {
    const res = await this.client.request<{ missing: string[] }>('/api/chunks/check', {
      method: 'POST',
      body: { siteId, hashes },
    });
    return res.data.missing;
  }

  async uploadUrls(
    siteId: string,
    hashes: readonly string[],
  ): Promise<{ urls: Record<string, string>; expiresAt: string }> {
    const res = await this.client.request<{ urls: Record<string, string>; expiresAt: string }>(
      '/api/chunks/upload-urls',
      { method: 'POST', body: { siteId, hashes } },
    );
    return res.data;
  }

  async downloadUrls(
    siteId: string,
    hashes: readonly string[],
  ): Promise<{ urls: Record<string, string>; expiresAt: string }> {
    const res = await this.client.request<{ urls: Record<string, string>; expiresAt: string }>(
      '/api/chunks/download-urls',
      { method: 'POST', body: { siteId, hashes } },
    );
    return res.data;
  }

  async mount(digest: string, siteId: string, from: string, to: string): Promise<{
    digest: string;
    siteId: string;
    from: string;
    to: string;
    mounted: true;
    zeroByte: true;
  }> {
    const res = await this.client.request<{
      digest: string;
      siteId: string;
      from: string;
      to: string;
      mounted: true;
      zeroByte: true;
    }>(`/api/chunks/${encodeURIComponent(digest)}/mount`, {
      method: 'POST',
      query: { siteId, from, to },
    });
    return res.data;
  }

  async referrers(
    digest: string,
    siteId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<{
    digest: string;
    siteId: string;
    referrers: Array<Record<string, unknown>>;
    nextPageToken: string;
  }> {
    const res = await this.client.request<{
      digest: string;
      siteId: string;
      referrers: Array<Record<string, unknown>>;
      nextPageToken: string;
    }>(`/api/chunks/${encodeURIComponent(digest)}/referrers`, {
      query: { siteId, page_size: opts.limit, page_token: opts.cursor },
    });
    return res.data;
  }
}
