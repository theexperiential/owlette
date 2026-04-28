import type { RoostClient } from '../lib/client';
import type { VersionSummary } from './roosts';

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

export interface ListVersionsOptions {
  siteId: string;
  /** Deprecated alias for pageSize; use pageSize for new code. */
  limit?: number;
  /** Deprecated alias for pageToken; use pageToken for new code. */
  cursor?: string;
  pageSize?: number;
  pageToken?: string;
}

export interface ListVersionsResult {
  versions: Array<Record<string, unknown>>;
  nextPageToken: string;
  /** Deprecated alias retained for older callers. */
  nextCursor: string | null;
}

interface ListVersionsResponse {
  versions: Array<Record<string, unknown>>;
  nextPageToken?: string;
  next_page_token?: string;
  nextCursor?: string | null;
}

export interface PatchVersionOptions {
  siteId: string;
  description: string | null;
  idempotencyKey?: string;
}

export class Versions {
  constructor(private readonly client: RoostClient) {}

  async list(
    roostId: string,
    opts: ListVersionsOptions,
  ): Promise<ListVersionsResult> {
    const res = await this.client.request<ListVersionsResponse>(
      `/api/roosts/${encodeURIComponent(roostId)}/versions`,
      {
        query: {
          siteId: opts.siteId,
          page_size: opts.pageSize ?? opts.limit,
          page_token: opts.pageToken ?? opts.cursor,
        },
      },
    );
    const nextPageToken =
      res.data.nextPageToken ?? res.data.next_page_token ?? res.data.nextCursor ?? '';
    return {
      versions: res.data.versions,
      nextPageToken,
      nextCursor: res.data.nextCursor ?? (nextPageToken || null),
    };
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
    opts: ListVersionsOptions,
  ): Promise<VersionFilesPage> {
    const res = await this.client.request<VersionFilesPage>(
      `/api/roosts/${encodeURIComponent(roostId)}/versions/${encodeURIComponent(String(versionRef))}/files`,
      {
        query: {
          siteId: opts.siteId,
          page_size: opts.pageSize ?? opts.limit,
          page_token: opts.pageToken ?? opts.cursor,
        },
      },
    );
    return res.data;
  }

  async patch(
    roostId: string,
    versionRef: string | number,
    opts: PatchVersionOptions,
  ): Promise<VersionSummary> {
    const requestOpts: Parameters<RoostClient['request']>[1] = {
      method: 'PATCH',
      body: {
        siteId: opts.siteId,
        description: opts.description,
      },
    };
    if (opts.idempotencyKey) requestOpts.idempotencyKey = opts.idempotencyKey;
    const res = await this.client.request<VersionSummary>(
      `/api/roosts/${encodeURIComponent(roostId)}/versions/${encodeURIComponent(String(versionRef))}`,
      requestOpts,
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
