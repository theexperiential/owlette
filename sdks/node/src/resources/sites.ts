import type { OwletteClient } from '../lib/client';

export interface Site {
  id: string;
  name: string;
  plan: string | null;
  timezone: string | null;
  owner: string | null;
  createdAt: string | null;
  /**
   * True when process schedules run on the site's `timezone` instead of each
   * machine's own clock. Sites that were never asked report `false`.
   */
  schedulesFollowSiteTime: boolean;
}

export class Sites {
  constructor(private readonly client: OwletteClient) {}

  async list(): Promise<Site[]> {
    const res = await this.client.request<{ sites: Site[] }>('/api/sites');
    return res.data.sites;
  }

  async get(siteId: string): Promise<Site> {
    const res = await this.client.request<Site>(`/api/sites/${encodeURIComponent(siteId)}`);
    return res.data;
  }
}
