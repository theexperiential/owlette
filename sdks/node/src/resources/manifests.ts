import type { RoostClient } from '../lib/client';

export interface ManifestDetail {
  manifestId: string;
  roostId: string;
  siteId: string;
  manifest: Record<string, unknown>;
  metadata: {
    manifestUrl: string | null;
    createdAt: string | null;
    createdBy: string | null;
    totalSize: number;
    totalFiles: number;
    parentManifestId: string | null;
  };
}

export interface ManifestFilesPage {
  manifestId: string;
  roostId: string;
  siteId: string;
  total: number;
  files: Array<{ path: string; size: number; chunks: Array<{ hash: string; size: number }> }>;
  nextPageToken: string;
}

export interface ManifestDiff {
  manifestId: string;
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

export class Manifests {
  constructor(private readonly client: RoostClient) {}

  async list(
    roostId: string,
    opts: { siteId: string; limit?: number; cursor?: string },
  ): Promise<{ manifests: Array<Record<string, unknown>>; nextCursor: string | null }> {
    const res = await this.client.request<{
      manifests: Array<Record<string, unknown>>;
      nextCursor: string | null;
    }>(`/api/roosts/${encodeURIComponent(roostId)}/manifests`, {
      query: { siteId: opts.siteId, limit: opts.limit, cursor: opts.cursor },
    });
    return res.data;
  }

  async get(
    roostId: string,
    manifestId: string,
    opts: { siteId: string },
  ): Promise<ManifestDetail> {
    const res = await this.client.request<ManifestDetail>(
      `/api/roosts/${encodeURIComponent(roostId)}/manifests/${encodeURIComponent(manifestId)}`,
      { query: { siteId: opts.siteId } },
    );
    return res.data;
  }

  async files(
    roostId: string,
    manifestId: string,
    opts: { siteId: string; limit?: number; cursor?: string },
  ): Promise<ManifestFilesPage> {
    const res = await this.client.request<ManifestFilesPage>(
      `/api/roosts/${encodeURIComponent(roostId)}/manifests/${encodeURIComponent(manifestId)}/files`,
      {
        query: { siteId: opts.siteId, limit: opts.limit, cursor: opts.cursor },
      },
    );
    return res.data;
  }

  async diff(
    roostId: string,
    manifestId: string,
    opts: { siteId: string; against: string },
  ): Promise<ManifestDiff> {
    const res = await this.client.request<ManifestDiff>(
      `/api/roosts/${encodeURIComponent(roostId)}/manifests/${encodeURIComponent(manifestId)}/diff`,
      { query: { siteId: opts.siteId, against: opts.against } },
    );
    return res.data;
  }
}
