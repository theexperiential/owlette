import type { OwletteClient } from '../lib/client';

export interface QuotaSnapshot {
  siteId: string;
  /**
   * Pricing tier of the site: `core` carries no roost storage, `pro`
   * includes 1 TiB. Left open to unknown strings so a tier introduced
   * server-side still parses against an older SDK.
   */
  tier: 'core' | 'pro' | string;
  usedBytes: number;
  pendingBytes: number;
  committedBytes: number;
  limitBytes: number | null;
  fractionUsed: number | null;
  /**
   * Whether roost is part of this site's tier. `false` on `core`, where
   * uploads are rejected with `403 tier_insufficient`.
   */
  roostAvailable: boolean;
  lastAlarmLevel: number;
  lastAlarmAt: string | null;
  lastReconciledAt: string | null;
  alarms: Array<{ id: string; threshold: number | null; firedAt: string | null }>;
}

export interface QuotaHistoryDay {
  date: string;
  storageBytesAvg: number | null;
  classAOps: number;
  classBOps: number;
  egressBytes: number;
}

export class Quotas {
  constructor(private readonly client: OwletteClient) {}

  async current(siteId: string): Promise<QuotaSnapshot> {
    const res = await this.client.request<QuotaSnapshot>(
      `/api/sites/${encodeURIComponent(siteId)}/quota`,
    );
    return res.data;
  }

  async history(
    siteId: string,
    period: '7d' | '14d' | '30d' | '60d' | '90d' = '30d',
  ): Promise<{ siteId: string; period: string; days: number; daily: QuotaHistoryDay[] }> {
    const res = await this.client.request<{
      siteId: string;
      period: string;
      days: number;
      daily: QuotaHistoryDay[];
    }>(`/api/sites/${encodeURIComponent(siteId)}/quota/history`, {
      query: { period },
    });
    return res.data;
  }
}
