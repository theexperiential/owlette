import type { RoostClient } from '../lib/client';

export interface VersionDetail {
  versionId: string;
  versionNumber: number;
  description: string | null;
  roostId: string;
  siteId: string;
  version: Record<string, unknown>;
  metadata: {
    versionUrl: string | null;
    createdAt: string | null;
    createdBy: string | null;
    totalSize: number;
    totalFiles: number;
    parentVersionId: string | null;
  };
}

export interface VersionFilesPage {
  versionId: string;
  versionNumber: number;
  roostId: string;
  siteId: string;
  total: number;
  files: Array<{ path: string; size: number; chunks: Array<{ hash: string; size: number }> }>;
  nextPageToken: string;
}

export interface VersionDiff {
  versionId: string;
  versionNumber: number;
  against: string;
  roostId: string;
  siteId: string;
  summary: {
    added: number;
    removed: number;
    changed: number;
    unchanged: number;
    hasChanges: boolean;
    netBytesDelta: number;
  };
  added: Array<{ path: string; size: number; reason: 'added'; chunks: number }>;
  removed: Array<{ path: string; size: number; reason: 'removed'; chunks: number }>;
  modified: Array<{
    path: string;
    fromSize: number;
    toSize: number;
    reason: 'modified';
    fromChunks: number;
    toChunks: number;
  }>;
}

export class Versions {
  constructor(private readonly client: RoostClient) {}

  async list(
    roostId: string,
    opts: { siteId: string; limit?: number; cursor?: string },
  ): Promise<{ versions: Array<Record<string, unknown>>; nextCursor: string | null }> {
    const res = await this.client.request<{
      versions: Array<Record<string, unknown>>;
      nextCursor: string | null;
    }>(`/api/roosts/${encodeURIComponent(roostId)}/versions`, {
      query: { siteId: opts.siteId, limit: opts.limit, cursor: opts.cursor },
    });
    return res.data;
  }

  async get(
    roostId: string,
    versionRef: string | number,
    opts: { siteId: string },
  ): Promise<VersionDetail> {
    const res = await this.client.request<VersionDetail>(
      `/api/roosts/${encodeURIComponent(roostId)}/versions/${encodeURIComponent(String(versionRef))}`,
      { query: { siteId: opts.siteId } },
    );
    return res.data;
  }

  async files(
    roostId: string,
    versionRef: string | number,
    opts: { siteId: string; limit?: number; cursor?: string },
  ): Promise<VersionFilesPage> {
    const res = await this.client.request<VersionFilesPage>(
      `/api/roosts/${encodeURIComponent(roostId)}/versions/${encodeURIComponent(String(versionRef))}/files`,
      {
        query: { siteId: opts.siteId, limit: opts.limit, cursor: opts.cursor },
      },
    );
    return res.data;
  }

  async diff(
    roostId: string,
    versionRef: string | number,
    opts: { siteId: string; against: string | number },
  ): Promise<VersionDiff> {
    const res = await this.client.request<VersionDiff>(
      `/api/roosts/${encodeURIComponent(roostId)}/versions/${encodeURIComponent(String(versionRef))}/diff`,
      { query: { siteId: opts.siteId, against: String(opts.against) } },
    );
    return res.data;
  }
}
