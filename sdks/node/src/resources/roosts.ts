/**
 * `owlette.roosts.*` resource.
 *
 * Flagship methods:
 *   push(dir, roostId, opts)    — chunk → dedup → upload → publish
 *   rollback(roostId, opts)     — POST /api/roosts/{id}/rollback
 *   deploy(roostId, opts)       — POST /api/roosts/{id}/deploy
 *
 * Plus CRUD:
 *   list(opts), get(roostId, opts), create(opts), patch(roostId, opts),
 *   remove(roostId, opts).
 *
 * `push` accepts an `onProgress` callback that fires during both the
 * chunk-hashing phase and the upload phase so UI code can render a
 * unified progress bar.
 */

import { EventEmitter } from 'events';
import { createReadStream } from 'fs';
import { hostname, platform } from 'os';
import { join } from 'path';
import type { OwletteClient } from '../lib/client';
import {
  chunkDirectory,
  type ChunkDirectoryOpts,
  type ChunkProgressEvent,
  type ChunkedFileEntry,
  uniqueHashes,
} from '../lib/chunker';

const UPLOAD_CONCURRENCY = 8;
const CHECK_BATCH_SIZE = 900;
const PUSH_MAX_RETRIES = 5;

/* --------------------------------------------------------------------- */
/*  types                                                                */
/* --------------------------------------------------------------------- */

export interface RoostSummary {
  roostId: string;
  siteId: string;
  name: string;
  targets: string[];
  currentVersionId: string | null;
  previousVersionId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
}

export interface VersionSummary {
  versionId: string;
  versionNumber: number;
  description: string | null;
  versionUrl: string | null;
  createdAt: string | null;
  createdBy: string | null;
  totalSize: number;
  totalFiles: number;
  parentVersionId: string | null;
}

export interface RoostDetail extends RoostSummary {
  extractPath: string | null;
  schemaVersion: number;
  versionUrl: string | null;
  currentVersion: VersionSummary | null;
  previousVersion: VersionSummary | null;
}

export interface ListRoostsOptions {
  siteId: string;
  pageSize?: number;
  cursor?: string;
  includeDeleted?: boolean;
}

export interface ListRoostsResult {
  roosts: RoostSummary[];
  nextPageToken: string;
}

export interface CreateRoostOptions {
  siteId: string;
  name: string;
  targets?: string[];
  extractPath?: string;
  roostId?: string;
}

export interface PatchRoostOptions {
  siteId: string;
  name?: string;
  targets?: string[];
  extractPath?: string;
}

export interface RollbackOptions {
  siteId: string;
  /**
   * Target version to roll back to. Accepts a version number (`3`), a
   * stringified number (`'3'`), a stable `vrs_*` id, or an alias
   * (`'current'` / `'previous'` / `'first'`). Server-side resolver
   * interprets the raw value — don't pre-parse on the client.
   */
  targetVersion?: string | number;
  idempotencyKey?: string;
}

export interface DeployOptions {
  siteId: string;
  versionId?: string;
  machines?: string[];
  scheduleAt?: string | Date;
  dryRun?: boolean;
  idempotencyKey?: string;
}

export interface DeployResult {
  rolloutId: string;
  versionId: string;
  siteId: string;
  roostId: string;
  stage: string;
  canary: string[];
  fleet: string[];
  extractRoot: string;
  versionUrl: string;
  dryRun?: boolean;
  alreadyRunning?: boolean;
  scheduled?: { at: string; warning: string };
}

export interface RollbackResult {
  currentVersionId: string;
  previousVersionId: string | null;
}

export interface PushOptions {
  /**
   * Site the roost belongs to — required because a single api key may span
   * multiple sites.
   */
  siteId: string;
  /** Optional display name passed through to the server on first publish. */
  name?: string;
  /** Override the roost's `targets[]` for this publish. */
  targets?: string[];
  /** Override the agent's extract root for this deploy. */
  extractPath?: string;
  /**
   * Optional plaintext description for the new version (≤500 chars).
   * Persisted on the version doc and surfaced in the ui version history.
   */
  description?: string;
  /** Progress emitter for UI. Listen for 'progress' events. */
  onProgress?: (evt: PushProgressEvent) => void;
  /** Ignore these directory / file names in addition to the defaults. */
  ignore?: readonly string[];
}

export type PushProgressEvent =
  | ChunkProgressEvent
  | {
      phase: 'check-missing';
      total: number;
      missing: number;
    }
  | {
      phase: 'upload';
      uploaded: number;
      total: number;
    }
  | {
      phase: 'publish';
      attempt: number;
    };

export interface PushResult {
  versionId: string;
  versionNumber: number;
  currentVersionId: string;
  previousVersionId: string | null;
  stats: {
    fileCount: number;
    totalBytes: number;
    totalChunks: number;
    uniqueChunks: number;
    uploadedChunks: number;
  };
}

/* --------------------------------------------------------------------- */
/*  resource                                                             */
/* --------------------------------------------------------------------- */

export class Roosts {
  constructor(
    private readonly client: OwletteClient,
    private readonly cliVersion: string,
  ) {}

  async list(opts: ListRoostsOptions): Promise<ListRoostsResult> {
    const res = await this.client.request<ListRoostsResult>('/api/roosts', {
      query: {
        siteId: opts.siteId,
        page_size: opts.pageSize,
        page_token: opts.cursor,
        includeDeleted: opts.includeDeleted ? 'true' : undefined,
      },
    });
    return res.data;
  }

  async get(roostId: string, opts: { siteId: string }): Promise<RoostDetail> {
    const res = await this.client.request<RoostDetail>(
      `/api/roosts/${encodeURIComponent(roostId)}`,
      { query: { siteId: opts.siteId } },
    );
    return res.data;
  }

  async create(opts: CreateRoostOptions): Promise<{ roostId: string; siteId: string; name: string; targets: string[] }> {
    const res = await this.client.request<{ roostId: string; siteId: string; name: string; targets: string[] }>(
      '/api/roosts',
      { method: 'POST', body: opts },
    );
    return res.data;
  }

  async patch(
    roostId: string,
    opts: PatchRoostOptions,
  ): Promise<{ roostId: string; siteId: string; updated: string[] }> {
    const res = await this.client.request<{ roostId: string; siteId: string; updated: string[] }>(
      `/api/roosts/${encodeURIComponent(roostId)}`,
      { method: 'PATCH', body: opts },
    );
    return res.data;
  }

  async remove(
    roostId: string,
    opts: { siteId: string },
  ): Promise<{ softDeleted: boolean; tombstoneExpiresAt: string }> {
    const res = await this.client.request<{ softDeleted: boolean; tombstoneExpiresAt: string }>(
      `/api/roosts/${encodeURIComponent(roostId)}`,
      { method: 'DELETE', query: { siteId: opts.siteId } },
    );
    return res.data;
  }

  async rollback(roostId: string, opts: RollbackOptions): Promise<RollbackResult> {
    const body: Record<string, unknown> = { siteId: opts.siteId };
    if (opts.targetVersion !== undefined) body.targetVersion = opts.targetVersion;
    const requestOpts: Parameters<OwletteClient['request']>[1] = {
      method: 'POST',
      body,
    };
    if (opts.idempotencyKey) requestOpts.idempotencyKey = opts.idempotencyKey;
    const res = await this.client.request<RollbackResult>(
      `/api/roosts/${encodeURIComponent(roostId)}/rollback`,
      requestOpts,
    );
    return res.data;
  }

  async deploy(roostId: string, opts: DeployOptions): Promise<DeployResult> {
    const body: Record<string, unknown> = { siteId: opts.siteId };
    if (opts.versionId) body.versionId = opts.versionId;
    if (opts.machines) body.machines = opts.machines;
    if (opts.scheduleAt) {
      body.scheduleAt =
        opts.scheduleAt instanceof Date
          ? opts.scheduleAt.toISOString()
          : opts.scheduleAt;
    }
    if (opts.dryRun) body.dryRun = true;
    const requestOpts: Parameters<OwletteClient['request']>[1] = {
      method: 'POST',
      body,
    };
    if (opts.idempotencyKey) requestOpts.idempotencyKey = opts.idempotencyKey;
    const res = await this.client.request<DeployResult>(
      `/api/roosts/${encodeURIComponent(roostId)}/deploy`,
      requestOpts,
    );
    return res.data;
  }

  /**
   * Publish a directory as a new version on an existing roost. This is
   * the end-to-end pipeline — the most common sdk entry point.
   *
   * Returns the publish result AND mirrors the progress callback onto
   * the returned object as an `events` EventEmitter so callers can
   * choose whichever style fits. Emitter event name: `'progress'`.
   */
  async push(
    dir: string,
    roostId: string,
    opts: PushOptions,
  ): Promise<PushResult & { events: EventEmitter }> {
    const emitter = new EventEmitter();
    const onProgress = (evt: PushProgressEvent): void => {
      emitter.emit('progress', evt);
      opts.onProgress?.(evt);
    };

    const chunkOpts: ChunkDirectoryOpts = { onProgress };
    if (opts.ignore) chunkOpts.ignore = opts.ignore;
    const files = await chunkDirectory(dir, chunkOpts);

    if (files.length === 0) {
      throw new Error('push: no non-empty files found under ' + dir);
    }

    const stats = summarise(files);
    const allHashes = uniqueHashes(files);
    const missing = await this.#checkMissing(opts.siteId, allHashes);
    onProgress({ phase: 'check-missing', total: allHashes.length, missing: missing.length });

    let uploadedChunks = 0;
    if (missing.length > 0) {
      const urls = await this.#mintUploadUrls(opts.siteId, missing);
      uploadedChunks = await this.#uploadChunksInParallel(dir, files, missing, urls, (uploaded, total) => {
        onProgress({ phase: 'upload', uploaded, total });
      });
    }

    const version = buildVersionObject(files, this.cliVersion);
    const publishResult = await this.#publishWithRetry({
      roostId,
      siteId: opts.siteId,
      version,
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.targets ? { targets: opts.targets } : {}),
      ...(opts.extractPath ? { extractPath: opts.extractPath } : {}),
      ...(opts.description ? { description: opts.description } : {}),
      onRetry: (attempt) => onProgress({ phase: 'publish', attempt }),
    });

    return {
      versionId: publishResult.versionId,
      versionNumber: publishResult.versionNumber,
      currentVersionId: publishResult.currentVersionId,
      previousVersionId: publishResult.previousVersionId,
      stats: { ...stats, uploadedChunks },
      events: emitter,
    };
  }

  /* ------------------------- private helpers ------------------------ */

  async #checkMissing(siteId: string, hashes: readonly string[]): Promise<string[]> {
    const missing: string[] = [];
    for (let i = 0; i < hashes.length; i += CHECK_BATCH_SIZE) {
      const batch = hashes.slice(i, i + CHECK_BATCH_SIZE);
      const res = await this.client.request<{ missing: string[] }>(
        '/api/chunks/check',
        { method: 'POST', body: { siteId, hashes: batch } },
      );
      missing.push(...res.data.missing);
    }
    return missing;
  }

  async #mintUploadUrls(
    siteId: string,
    hashes: readonly string[],
  ): Promise<Record<string, string>> {
    const all: Record<string, string> = {};
    for (let i = 0; i < hashes.length; i += CHECK_BATCH_SIZE) {
      const batch = hashes.slice(i, i + CHECK_BATCH_SIZE);
      const res = await this.client.request<{ urls: Record<string, string> }>(
        '/api/chunks/upload-urls',
        { method: 'POST', body: { siteId, hashes: batch } },
      );
      Object.assign(all, res.data.urls);
    }
    return all;
  }

  async #uploadChunksInParallel(
    dir: string,
    files: readonly ChunkedFileEntry[],
    missing: readonly string[],
    urls: Record<string, string>,
    onProgress: (uploaded: number, total: number) => void,
  ): Promise<number> {
    interface Source {
      absPath: string;
      offset: number;
      size: number;
    }
    const sourceByHash = new Map<string, Source>();
    for (const f of files) {
      let offset = 0;
      for (const c of f.chunks) {
        if (!sourceByHash.has(c.hash)) {
          sourceByHash.set(c.hash, {
            absPath: join(dir, ...f.path.split('/')),
            offset,
            size: c.size,
          });
        }
        offset += c.size;
      }
    }

    let uploaded = 0;
    const total = missing.length;
    const queue = [...missing];
    const worker = async (): Promise<void> => {
      for (;;) {
        const hash = queue.shift();
        if (!hash) return;
        const source = sourceByHash.get(hash);
        const url = urls[hash];
        if (!source || !url) throw new Error(`internal: no source for chunk ${hash}`);
        await this.#putChunk(hash, source.absPath, source.offset, source.size, url);
        uploaded += 1;
        if (uploaded % 4 === 0 || uploaded === total) onProgress(uploaded, total);
      }
    };

    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(UPLOAD_CONCURRENCY, total); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    return uploaded;
  }

  async #putChunk(
    hash: string,
    absPath: string,
    offset: number,
    size: number,
    url: string,
  ): Promise<void> {
    const stream = createReadStream(absPath, { start: offset, end: offset + size - 1 });
    const bufs: Buffer[] = [];
    for await (const chunk of stream) bufs.push(chunk as Buffer);
    const body = Buffer.concat(bufs);
    if (body.length !== size) {
      throw new Error(
        `chunk ${hash}: expected ${size} bytes, read ${body.length} from ${absPath}`,
      );
    }

    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.client._fetch(url, {
          method: 'PUT',
          body: new Uint8Array(body),
          headers: { 'Content-Type': 'application/octet-stream' },
        });
        if (!res.ok) throw new Error(`PUT ${hash} → ${res.status}`);
        return;
      } catch (err) {
        lastErr = err as Error;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 250));
      }
    }
    throw lastErr ?? new Error(`PUT ${hash}: unknown error`);
  }

  async #publishWithRetry(input: {
    roostId: string;
    siteId: string;
    version: unknown;
    name?: string;
    targets?: string[];
    extractPath?: string;
    description?: string;
    onRetry?: (attempt: number) => void;
  }): Promise<{
    versionId: string;
    versionNumber: number;
    currentVersionId: string;
    previousVersionId: string | null;
  }> {
    let expectedCurrent: string | null = null;
    let lastErr: unknown = null;

    for (let attempt = 0; attempt < PUSH_MAX_RETRIES; attempt++) {
      if (attempt > 0) input.onRetry?.(attempt);
      const body: Record<string, unknown> = {
        siteId: input.siteId,
        version: input.version,
      };
      if (expectedCurrent !== null) body.expectedCurrentVersionId = expectedCurrent;
      if (input.name) body.name = input.name;
      if (input.targets) body.targets = input.targets;
      if (input.extractPath) body.extractPath = input.extractPath;
      if (input.description) body.description = input.description;

      try {
        const res = await this.client.request<{
          versionId: string;
          versionNumber: number;
          currentVersionId: string;
          previousVersionId: string | null;
        }>(`/api/roosts/${encodeURIComponent(input.roostId)}/versions`, {
          method: 'POST',
          body,
          noRetry: true, // we drive the retry ourselves for 412 handling
        });
        return {
          versionId: res.data.versionId,
          versionNumber: res.data.versionNumber,
          currentVersionId: res.data.currentVersionId,
          previousVersionId: res.data.previousVersionId ?? null,
        };
      } catch (err) {
        lastErr = err;
        const isApiError = err instanceof Error && err.name === 'OwletteApiError';
        if (!isApiError) throw err;
        const apiErr = err as unknown as {
          status: number;
          problem: Record<string, unknown>;
        };
        if (apiErr.status !== 412) throw err;
        const detail = typeof apiErr.problem.detail === 'string' ? apiErr.problem.detail : '';
        const matched = /\((?<cur>[a-f0-9-]+|null)\)/.exec(detail)?.groups?.cur ?? null;
        expectedCurrent = matched && matched !== 'null' ? matched : null;
      }
    }

    throw lastErr ?? new Error('version publish failed after retries');
  }
}

/* --------------------------------------------------------------------- */
/*  helpers                                                              */
/* --------------------------------------------------------------------- */

function summarise(files: readonly ChunkedFileEntry[]): {
  fileCount: number;
  totalBytes: number;
  totalChunks: number;
  uniqueChunks: number;
} {
  let totalBytes = 0;
  let totalChunks = 0;
  const unique = new Set<string>();
  for (const f of files) {
    totalBytes += f.size;
    totalChunks += f.chunks.length;
    for (const c of f.chunks) unique.add(c.hash);
  }
  return { fileCount: files.length, totalBytes, totalChunks, uniqueChunks: unique.size };
}

function buildVersionObject(
  files: readonly ChunkedFileEntry[],
  cliVersion: string,
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    mediaType: 'application/vnd.owlette.version.v1+json',
    config: {
      producer: '@owlette/sdk node-sdk',
      cliVersion,
      createdAt: new Date().toISOString(),
      hostname: hostname(),
      platform: platform(),
    },
    files: [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}
