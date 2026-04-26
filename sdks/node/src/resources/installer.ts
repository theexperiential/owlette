/**
 * `roost.installer` — superadmin-only installer-version management.
 *
 * Wraps the wave-1B installer-api routes:
 *
 *   GET    /api/installer
 *   POST   /api/installer/upload                 — request signed upload URL
 *   PUT    /api/installer/upload                 — finalize the upload
 *   POST   /api/installer/{version}/set-latest
 *   DELETE /api/installer/{version}
 *
 * The `upload` flow is a 3-step convenience: POST → PUT to the signed URL
 * with the binary → PUT (finalize). The sha-256 of the binary is computed
 * client-side via `crypto.createHash` and passed to the finalize call so
 * the server doesn't have to re-download the object.
 *
 * Mutations auto-generate `Idempotency-Key` headers when the caller omits
 * one. Errors surface as `RoostApiError`.
 */
import { createHash, randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import type { RoostClient } from '../lib/client';

/* --------------------------------------------------------------------- */
/*  types                                                                */
/* --------------------------------------------------------------------- */

export interface InstallerVersion {
  version: string;
  download_url: string | null;
  checksum_sha256: string | null;
  release_notes: string | null;
  file_size: number | null;
  uploaded_at: number | null;
  uploaded_by: string | null;
  deletedAt: number | null;
}

export interface ListInstallerOptions {
  pageSize?: number;
  pageToken?: string;
  includeDeleted?: boolean;
}

export interface ListInstallerResult {
  versions: InstallerVersion[];
  nextPageToken: string;
}

export interface UploadRequestOptions {
  /** Local path to the `.exe` to upload. */
  filePath: string;
  /** Semver `X.Y.Z`. */
  version: string;
  /** File name on storage; defaults to the basename of `filePath`. */
  fileName?: string;
  contentType?: string;
  releaseNotes?: string | null;
  /** Whether to promote this version to `latest` on finalize. Default true. */
  setAsLatest?: boolean;
  /** Override the auto-generated idempotency key for the start step. */
  startIdempotencyKey?: string;
  /** Override the auto-generated idempotency key for the finalize step. */
  finalizeIdempotencyKey?: string;
  /**
   * Optional override of the upload PUT. Defaults to `client._fetch` so that
   * any custom proxy/agent the user passed at construction time is honoured.
   */
  signedUploadFetch?: typeof fetch;
}

export interface UploadResult {
  version: string;
  download_url: string;
  checksum_sha256: string;
  file_size: number;
}

/* --------------------------------------------------------------------- */
/*  resource                                                             */
/* --------------------------------------------------------------------- */

export class Installer {
  constructor(private readonly client: RoostClient) {}

  async list(opts: ListInstallerOptions = {}): Promise<ListInstallerResult> {
    const query: Record<string, string | number | boolean | undefined> = {};
    if (opts.pageSize !== undefined) query.page_size = opts.pageSize;
    if (opts.pageToken !== undefined) query.page_token = opts.pageToken;
    if (opts.includeDeleted) query.includeDeleted = 'true';

    const res = await this.client.request<{
      versions: InstallerVersion[];
      nextPageToken: string;
    }>('/api/installer', { query });
    return res.data;
  }

  /**
   * Three-step upload: request signed URL, PUT the binary, finalize.
   *
   * Computes a sha-256 of the file once (streamed) and passes it to the
   * finalize call. Returns the finalized version metadata.
   */
  async upload(opts: UploadRequestOptions): Promise<UploadResult> {
    const fileName =
      opts.fileName ?? opts.filePath.split(/[\\/]/).pop() ?? 'installer.exe';
    const contentType = opts.contentType ?? 'application/octet-stream';

    // ── 1. POST /api/installer/upload — request signed URL ───────────────
    const startBody: Record<string, unknown> = {
      version: opts.version,
      fileName,
      contentType,
    };
    if (opts.releaseNotes !== undefined) startBody.releaseNotes = opts.releaseNotes;
    if (opts.setAsLatest !== undefined) startBody.setAsLatest = opts.setAsLatest;

    const startRes = await this.client.request<{
      uploadUrl: string;
      uploadId: string;
      storagePath: string;
      expiresAt: string;
    }>('/api/installer/upload', {
      method: 'POST',
      body: startBody,
      idempotencyKey:
        opts.startIdempotencyKey ?? `sdk-installer-upload-start-${randomUUID()}`,
    });
    const { uploadUrl, uploadId } = startRes.data;

    // ── 2. PUT signed URL — upload the binary ─────────────────────────────
    const fileStat = await stat(opts.filePath);
    const fileSize = fileStat.size;
    const sha256 = await sha256OfFile(opts.filePath);

    const buffer = await readFileToBuffer(opts.filePath);
    const uploadFetch = opts.signedUploadFetch ?? this.client._fetch;
    const putRes = await uploadFetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: new Uint8Array(buffer),
    });
    if (!putRes.ok) {
      throw new Error(
        `installer.upload: signed-url PUT failed with status ${putRes.status} ` +
          `(${fileSize} bytes from ${opts.filePath})`,
      );
    }

    // ── 3. PUT /api/installer/upload — finalize ──────────────────────────
    const finalizeRes = await this.client.request<UploadResult>(
      '/api/installer/upload',
      {
        method: 'PUT',
        body: { uploadId, checksum_sha256: sha256 },
        idempotencyKey:
          opts.finalizeIdempotencyKey ??
          `sdk-installer-upload-finalize-${randomUUID()}`,
      },
    );
    return finalizeRes.data;
  }

  async setLatest(
    version: string,
    opts: { idempotencyKey?: string } = {},
  ): Promise<{ version: string; latest: Record<string, unknown> }> {
    const res = await this.client.request<{
      version: string;
      latest: Record<string, unknown>;
    }>(`/api/installer/${encodeURIComponent(version)}/set-latest`, {
      method: 'POST',
      body: {},
      idempotencyKey: opts.idempotencyKey ?? `sdk-installer-set-latest-${randomUUID()}`,
    });
    return res.data;
  }

  async delete(
    version: string,
  ): Promise<{ version: string; deletedAt: number; alreadyDeleted: boolean }> {
    const res = await this.client.request<{
      version: string;
      deletedAt: number;
      alreadyDeleted: boolean;
    }>(`/api/installer/${encodeURIComponent(version)}`, {
      method: 'DELETE',
    });
    return res.data;
  }
}

/* --------------------------------------------------------------------- */
/*  helpers                                                              */
/* --------------------------------------------------------------------- */

async function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function readFileToBuffer(filePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => chunks.push(chunk as Buffer));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
