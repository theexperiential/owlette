import type { OwletteClient } from '../lib/client';

export interface QuotaSnapshot {
  siteId: string;
  tier: string;
  usedBytes: number;
  pendingBytes: number;
  committedBytes: number;
  limitBytes: number | null;
  fractionUsed: number | null;
  unlimited: boolean;
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
