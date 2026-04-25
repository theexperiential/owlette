/**
 * R2 client + signed-URL helpers (roost wave 2a, server-side only).
 *
 * R2 speaks the S3 API, so this module is a thin wrapper around
 * @aws-sdk/client-s3 pointed at the Cloudflare R2 S3 endpoint. Every
 * call enforces the per-tenant path prefix (`project-content/{siteId}/…`
 * or the version body prefix /{siteId}/…) — callers provide `siteId`,
 * never raw keys, so a caller authorised for site A can't trick this
 * module into signing a URL for site B.
 *
 * Env requirements (see `.claude/.env.local`):
 *   R2_S3_ACCESS_KEY_ID      — R2 API token access key id
 *   R2_S3_SECRET_ACCESS_KEY  — secret
 *   R2_S3_ENDPOINT           — https://<accountId>.r2.cloudflarestorage.com
 *
 * Bucket names are hard-coded to match `scripts/provision-r2.mjs` — if
 * a future wave splits prod/dev by env, swap these to env-driven.
 */

import 'server-only';
import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/* --------------------------------------------------------------------- */
/*  Constants                                                            */
/* --------------------------------------------------------------------- */

/** Environment — 'dev' for dev.owlette.app + localhost, 'prod' for owlette.app. */
export type RoostEnv = 'dev' | 'prod';

/** R2 bucket-kind tag. The `'manifests'` literal is retained as the bucket-name
 *  suffix until the physical R2 migration ships in wave 4 — see `bucketFor`. */
export type R2BucketKind = 'content' | 'manifests';

export function currentEnv(): RoostEnv {
  // Authoritative override — set `ROOST_ENV=prod` or `ROOST_ENV=dev`
  // explicitly in Railway if the heuristics below don't fit your setup.
  const explicit = process.env.ROOST_ENV;
  if (explicit === 'prod') return 'prod';
  if (explicit === 'dev') return 'dev';

  // Railway always builds with NODE_ENV=production, so NODE_ENV is
  // useless as a prod/dev signal on Railway. Rely on RAILWAY_ENVIRONMENT
  // (conventionally 'production' on the prod service) or the public
  // hostname (owlette.app = prod, everything else = dev).
  if (process.env.RAILWAY_ENVIRONMENT === 'production') return 'prod';
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN || '';
  if (domain === 'owlette.app') return 'prod';

  // Default to 'dev' — safer than defaulting to 'prod':
  //   - dev bucket corruption is recoverable
  //   - prod bucket writes from a misconfigured deploy aren't
  // Localhost `npm run dev` also lands here (NODE_ENV != 'production').
  return 'dev';
}

export function bucketFor(env: RoostEnv, kind: R2BucketKind): string {
  return `owlette-${env}-${kind}`;
}

/**
 * Per-tenant object key for a chunk. Shards by first-two hash chars so R2
 * listings don't bottleneck on a single prefix; matches the policy defined
 * in `storage/r2-bucket-policy.json` + documented in `docs/architecture.md`.
 */
export function chunkKey(siteId: string, hash: string): string {
  if (!isValidHash(hash)) throw new Error(`invalid chunk hash: ${hash}`);
  if (!isValidSiteId(siteId)) throw new Error(`invalid siteId: ${siteId}`);
  return `project-content/${siteId}/${hash.slice(0, 2)}/${hash}`;
}

export function versionKey(
  siteId: string,
  roostId: string,
  versionId: string,
): string {
  if (!isValidSiteId(siteId)) throw new Error(`invalid siteId: ${siteId}`);
  if (!isValidSiteId(roostId)) throw new Error(`invalid roostId: ${roostId}`);
  if (!isValidSiteId(versionId)) throw new Error(`invalid versionId: ${versionId}`);
  // kept as 'project-manifests/' until R2 migration ships in wave 4
  return `project-manifests/${siteId}/${roostId}/${versionId}.json`;
}

function isValidHash(h: unknown): h is string {
  return typeof h === 'string' && /^[0-9a-f]{64}$/.test(h);
}

function isValidSiteId(s: unknown): s is string {
  return (
    typeof s === 'string' &&
    s.length > 0 &&
    s.length <= 128 &&
    /^[A-Za-z0-9_\-.]+$/.test(s) &&
    !s.includes('..')
  );
}

/* --------------------------------------------------------------------- */
/*  Client singleton                                                     */
/* --------------------------------------------------------------------- */

let _client: S3Client | null = null;

export function getR2Client(): S3Client {
  if (_client) return _client;
  const endpoint = required('R2_S3_ENDPOINT');
  const accessKeyId = required('R2_S3_ACCESS_KEY_ID');
  const secretAccessKey = required('R2_S3_SECRET_ACCESS_KEY');
  _client = new S3Client({
    region: 'auto', // R2's convention — SDK requires SOMETHING here.
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true, // R2 requires path-style (bucket in path, not subdomain).
  });
  return _client;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) {
    throw new Error(
      `R2 env var ${name} missing. set it in .claude/.env.local (dev) or Railway env (prod).`,
    );
  }
  return v;
}

/* --------------------------------------------------------------------- */
/*  Chunk operations                                                     */
/* --------------------------------------------------------------------- */

/**
 * Is this chunk already in R2 for this tenant? HEAD is ~O(10ms) against
 * R2 edge. Returns true iff the object exists AND is non-zero.
 *
 * Never throws on "not found" — only on network/auth errors. Callers
 * distinguish "missing" from "broken" by the boolean vs. thrown Error.
 */
export async function hasChunk(siteId: string, hash: string): Promise<boolean> {
  // E2E branch: in playwright runs the next-server is launched with
  // OWLETTE_E2E=1 and points at the Firebase emulators (no real R2). A
  // chunk is considered "present" iff a presence row exists at
  // `siteChunks/{hash}` — seeded by `web/e2e/helpers/seed.ts:seedChunks`
  // before any test that lets POST /versions go through.
  if (process.env.OWLETTE_E2E === '1') {
    const { getAdminDb } = await import('@/lib/firebase-admin');
    const snap = await getAdminDb().collection('siteChunks').doc(hash).get();
    return snap.exists;
  }

  const client = getR2Client();
  const bucket = bucketFor(currentEnv(), 'content');
  try {
    const res = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: chunkKey(siteId, hash) }),
    );
    return (res.ContentLength ?? 0) > 0;
  } catch (err: unknown) {
    // SDK raises specific metadata.httpStatusCode on 404 — return false.
    const e = err as { $metadata?: { httpStatusCode?: number }; name?: string };
    if (e.$metadata?.httpStatusCode === 404 || e.name === 'NotFound') return false;
    throw err;
  }
}

/**
 * Bulk-check which of `hashes` are already present. Respects a
 * concurrency cap so a 1000-hash check doesn't open 1000 sockets.
 * Returns the subset of hashes that are MISSING from R2.
 */
export async function missingChunks(
  siteId: string,
  hashes: readonly string[],
  concurrency = 32,
): Promise<string[]> {
  const missing: string[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < hashes.length) {
      const i = cursor++;
      const h = hashes[i];
      const present = await hasChunk(siteId, h);
      if (!present) missing.push(h);
    }
  }
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, hashes.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return missing;
}

/** Default TTLs for presigned URLs — configurable per call. */
export const PUT_URL_TTL_SECONDS = 60 * 60; // 60 min
export const GET_URL_TTL_SECONDS = 15 * 60; // 15 min

export async function presignPutChunk(
  siteId: string,
  hash: string,
  ttlSeconds: number = PUT_URL_TTL_SECONDS,
): Promise<string> {
  const client = getR2Client();
  const bucket = bucketFor(currentEnv(), 'content');
  return getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: bucket, Key: chunkKey(siteId, hash) }),
    { expiresIn: ttlSeconds },
  );
}

export async function presignGetChunk(
  siteId: string,
  hash: string,
  ttlSeconds: number = GET_URL_TTL_SECONDS,
): Promise<string> {
  const client = getR2Client();
  const bucket = bucketFor(currentEnv(), 'content');
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: chunkKey(siteId, hash) }),
    { expiresIn: ttlSeconds },
  );
}

/* --------------------------------------------------------------------- */
/*  Version body operations                                              */
/* --------------------------------------------------------------------- */

/** Write a version JSON body. Idempotent — overwrite if same key exists. */
export async function putVersionBody(
  siteId: string,
  roostId: string,
  versionId: string,
  body: unknown,
): Promise<void> {
  const client = getR2Client();
  const bucket = bucketFor(currentEnv(), 'manifests');
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: versionKey(siteId, roostId, versionId),
      Body: JSON.stringify(body),
      ContentType: 'application/vnd.owlette.version.v1+json',
    }),
  );
}

export async function presignGetVersion(
  siteId: string,
  roostId: string,
  versionId: string,
  ttlSeconds: number = GET_URL_TTL_SECONDS,
): Promise<string> {
  const client = getR2Client();
  const bucket = bucketFor(currentEnv(), 'manifests');
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: bucket,
      Key: versionKey(siteId, roostId, versionId),
    }),
    { expiresIn: ttlSeconds },
  );
}

/**
 * Read + parse a version body from R2. Returns null if the key does not
 * exist. Throws on transport / parse errors.
 */
export async function getVersionBody(
  siteId: string,
  roostId: string,
  versionId: string,
): Promise<unknown | null> {
  const client = getR2Client();
  const bucket = bucketFor(currentEnv(), 'manifests');
  try {
    const resp = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: versionKey(siteId, roostId, versionId),
      }),
    );
    if (!resp.Body) return null;
    const text = await resp.Body.transformToString('utf-8');
    return JSON.parse(text);
  } catch (err) {
    const code = (err as { name?: string; Code?: string }).name
      ?? (err as { Code?: string }).Code;
    if (code === 'NoSuchKey' || code === 'NotFound') return null;
    throw err;
  }
}

/** Used by the chunk-verify callback if a verified chunk is a hash mismatch. */
export async function deleteChunk(
  siteId: string,
  hash: string,
): Promise<void> {
  const client = getR2Client();
  const bucket = bucketFor(currentEnv(), 'content');
  await client.send(
    new DeleteObjectCommand({ Bucket: bucket, Key: chunkKey(siteId, hash) }),
  );
}
