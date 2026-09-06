/**
 * Minimal S3-compatible (Cloudflare R2) client for cloud functions.
 *
 * Dependency-free on purpose. `functions/` ships firebase-admin + firebase-functions
 * only, and the three operations chunk GC needs — ListObjectsV2, GetObject,
 * DeleteObject — are all empty-body GET/DELETE requests, which a small SigV4 signer
 * covers without pulling `@aws-sdk/client-s3` (and its cold-start cost) into the
 * functions bundle. `web/lib/r2Client.server.ts` stays the SDK-backed client for the
 * request path; bucket naming and key layout are mirrored here on purpose — change
 * one and change the other.
 *
 * Required config (see the ops note at the top of chunkGc.ts):
 *   R2_S3_ENDPOINT, R2_S3_ACCESS_KEY_ID, R2_S3_SECRET_ACCESS_KEY, ROOST_ENV.
 *
 * Every failure throws. Callers in the GC path treat a throw as "cannot prove what is
 * live" and skip deletion — the store never reports a partial listing as complete.
 */

import { createHash, createHmac } from 'crypto';

export type RoostEnv = 'dev' | 'prod';
export type R2BucketKind = 'content' | 'manifests';

export interface R2Config {
  /** https://<accountId>.r2.cloudflarestorage.com — no trailing slash. */
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  env: RoostEnv;
}

/** Structural subset of the fetch Response we consume — keeps tests transport-free. */
export interface HttpResponseLike {
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<HttpResponseLike>;

export interface R2Client {
  /** Every key under `prefix`, following continuation tokens to completion. */
  listKeys(bucket: string, prefix: string): Promise<string[]>;
  /** Object body as UTF-8, or null when the key does not exist. */
  getText(bucket: string, key: string): Promise<string | null>;
  /** Delete one object. Idempotent — a missing key is a success. */
  deleteObject(bucket: string, key: string): Promise<void>;
}

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
/** R2 has no regions; the SigV4 scope still needs a value and 'auto' is R2's. */
const REGION = 'auto';
const MAX_LIST_KEYS_PER_PAGE = 1000;
/** Guard against a server that keeps handing back a continuation token. */
const MAX_LIST_PAGES = 10_000;

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

/**
 * Resolve which R2 environment this deployment owns.
 *
 * ROOST_ENV wins. Without it the firebase project id must name exactly one of
 * dev/prod — anything ambiguous throws rather than guessing, because guessing wrong
 * points a deletion job at the other environment's buckets.
 */
export function resolveRoostEnv(env: NodeJS.ProcessEnv = process.env): RoostEnv {
  const explicit = (env.ROOST_ENV ?? '').trim();
  if (explicit === 'dev' || explicit === 'prod') return explicit;
  if (explicit.length > 0) {
    throw new Error(`ROOST_ENV must be 'dev' or 'prod' (got '${explicit}')`);
  }

  const projectId = env.GCLOUD_PROJECT || env.GCP_PROJECT || '';
  const looksDev = projectId.includes('dev');
  const looksProd = projectId.includes('prod');
  if (looksDev && !looksProd) return 'dev';
  if (looksProd && !looksDev) return 'prod';
  throw new Error(
    `cannot resolve roost env from project id '${projectId}' — set ROOST_ENV=dev|prod`,
  );
}

export function loadR2Config(env: NodeJS.ProcessEnv = process.env): R2Config {
  const endpoint = requiredEnv(env, 'R2_S3_ENDPOINT').replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+$/.test(endpoint)) {
    throw new Error(
      `R2_S3_ENDPOINT must be an https origin like https://<accountId>.r2.cloudflarestorage.com (got '${endpoint}')`,
    );
  }
  return {
    endpoint,
    accessKeyId: requiredEnv(env, 'R2_S3_ACCESS_KEY_ID'),
    secretAccessKey: requiredEnv(env, 'R2_S3_SECRET_ACCESS_KEY'),
    env: resolveRoostEnv(env),
  };
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v || v.trim().length === 0) {
    throw new Error(
      `R2 env var ${name} is not set for the functions codebase — see functions/.env.example`,
    );
  }
  return v.trim();
}

// ---------------------------------------------------------------------------
// key layout (mirrors web/lib/r2Client.server.ts)
// ---------------------------------------------------------------------------

export function bucketFor(env: RoostEnv, kind: R2BucketKind): string {
  return `owlette-${env}-${kind}`;
}

const HASH_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[A-Za-z0-9_\-.]+$/;

export function isValidHash(h: unknown): h is string {
  return typeof h === 'string' && HASH_RE.test(h);
}

export function isValidId(s: unknown): s is string {
  return (
    typeof s === 'string' &&
    s.length > 0 &&
    s.length <= 128 &&
    ID_RE.test(s) &&
    !s.includes('..')
  );
}

export function chunkPrefix(siteId: string): string {
  if (!isValidId(siteId)) throw new Error(`invalid siteId: ${siteId}`);
  return `project-content/${siteId}/`;
}

export function chunkKey(siteId: string, hash: string): string {
  if (!isValidHash(hash)) throw new Error(`invalid chunk hash: ${hash}`);
  return `${chunkPrefix(siteId)}${hash.slice(0, 2)}/${hash}`;
}

export function versionKey(
  siteId: string,
  roostId: string,
  versionId: string,
): string {
  if (!isValidId(siteId)) throw new Error(`invalid siteId: ${siteId}`);
  if (!isValidId(roostId)) throw new Error(`invalid roostId: ${roostId}`);
  if (!isValidId(versionId)) throw new Error(`invalid versionId: ${versionId}`);
  return `project-manifests/${siteId}/${roostId}/${versionId}.json`;
}

/**
 * Inverse of `chunkKey`. Returns null for anything that is not exactly a chunk key
 * for this site — an unrecognised object is never a deletion candidate, so a stray
 * key under the tenant prefix leaks rather than risking a wrong delete.
 */
export function hashFromChunkKey(siteId: string, key: string): string | null {
  const prefix = chunkPrefix(siteId);
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  const parts = rest.split('/');
  if (parts.length !== 2) return null;
  const [shard, hash] = parts;
  if (!isValidHash(hash)) return null;
  if (shard !== hash.slice(0, 2)) return null;
  return hash;
}

// ---------------------------------------------------------------------------
// SigV4
// ---------------------------------------------------------------------------

/** RFC 3986 percent-encoding — encodeURIComponent leaves `!'()*` alone, S3 does not. */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Encode each path segment, keeping the separators. */
export function canonicalUri(path: string): string {
  return path.split('/').map(rfc3986).join('/');
}

export function canonicalQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(query[k])}`)
    .join('&');
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * SigV4 signing-key derivation chain. Exported so tests can pin it to AWS's published
 * vector — the one part of the signer with an authoritative external answer.
 */
export function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

export interface SignInput {
  method: string;
  host: string;
  /** Raw (un-encoded) path, e.g. `/bucket/project-content/site/ab/<hash>`. */
  path: string;
  query: Record<string, string>;
  accessKeyId: string;
  secretAccessKey: string;
  now: Date;
  /** Hex sha-256 of the body. Defaults to the empty-body digest. */
  payloadHash?: string;
}

/**
 * Header-based SigV4. `host` is signed but deliberately not returned: the HTTP client
 * sets it from the URL, and undici rejects a caller-set Host. The value signed and the
 * value sent are the same string, so the signature still verifies.
 */
export function signRequest(input: SignInput): Record<string, string> {
  const iso = input.now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const amzDate = iso;
  const dateStamp = iso.slice(0, 8);
  const payloadHash = input.payloadHash ?? sha256Hex('');

  const canonicalHeaders =
    `host:${input.host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [
    input.method,
    canonicalUri(input.path),
    canonicalQuery(input.query),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kSigning = deriveSigningKey(
    input.secretAccessKey,
    dateStamp,
    REGION,
    SERVICE,
  );
  const signature = createHmac('sha256', kSigning)
    .update(stringToSign, 'utf8')
    .digest('hex');

  return {
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    authorization:
      `${ALGORITHM} Credential=${input.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// ---------------------------------------------------------------------------
// ListObjectsV2 response parsing
// ---------------------------------------------------------------------------

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

function decodeXml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m] ?? m);
}

export interface ListPage {
  keys: string[];
  nextContinuationToken: string | null;
}

/**
 * Pull `<Contents><Key>` values out of a ListObjectsV2 body. Throws when the response
 * says truncated but hands back no continuation token — a silently short listing would
 * be read as "these are all the objects", and everything absent looks like an orphan.
 */
export function parseListObjectsV2(xml: string): ListPage {
  const keys: string[] = [];
  const contents = /<Contents\b[^>]*>([\s\S]*?)<\/Contents>/g;
  let match: RegExpExecArray | null;
  while ((match = contents.exec(xml)) !== null) {
    const keyMatch = /<Key>([\s\S]*?)<\/Key>/.exec(match[1]);
    if (keyMatch) keys.push(decodeXml(keyMatch[1]));
  }

  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
  if (!truncated) return { keys, nextContinuationToken: null };

  const tokenMatch = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(
    xml,
  );
  const token = tokenMatch ? decodeXml(tokenMatch[1]).trim() : '';
  if (token.length === 0) {
    throw new Error(
      'ListObjectsV2 reported IsTruncated with no NextContinuationToken — listing incomplete',
    );
  }
  return { keys, nextContinuationToken: token };
}

// ---------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------

function defaultFetch(): FetchLike {
  const f = (globalThis as { fetch?: unknown }).fetch;
  if (typeof f !== 'function') {
    throw new Error('global fetch is unavailable — node 18+ required');
  }
  return f as FetchLike;
}

export interface R2ClientDeps {
  fetchImpl?: FetchLike;
  now?: () => Date;
}

export function createR2Client(
  config: R2Config,
  deps: R2ClientDeps = {},
): R2Client {
  const fetchImpl = deps.fetchImpl ?? defaultFetch();
  const now = deps.now ?? (() => new Date());
  const host = config.endpoint.replace(/^https:\/\//, '');

  async function send(
    method: string,
    bucket: string,
    key: string,
    query: Record<string, string>,
  ): Promise<HttpResponseLike> {
    const path = `/${bucket}${key.length > 0 ? `/${key}` : ''}`;
    const headers = signRequest({
      method,
      host,
      path,
      query,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      now: now(),
    });
    const qs = canonicalQuery(query);
    const url = `${config.endpoint}${canonicalUri(path)}${qs ? `?${qs}` : ''}`;
    return fetchImpl(url, { method, headers });
  }

  async function failure(
    op: string,
    bucket: string,
    key: string,
    res: HttpResponseLike,
  ): Promise<Error> {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      detail = '<unreadable body>';
    }
    return new Error(
      `r2 ${op} ${bucket}/${key} failed: HTTP ${res.status} ${detail}`,
    );
  }

  return {
    async listKeys(bucket: string, prefix: string): Promise<string[]> {
      const keys: string[] = [];
      let token: string | null = null;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const query: Record<string, string> = {
          'list-type': '2',
          'max-keys': String(MAX_LIST_KEYS_PER_PAGE),
          prefix,
        };
        if (token) query['continuation-token'] = token;

        const res = await send('GET', bucket, '', query);
        if (res.status < 200 || res.status >= 300) {
          throw await failure('list', bucket, prefix, res);
        }
        const parsed = parseListObjectsV2(await res.text());
        keys.push(...parsed.keys);
        token = parsed.nextContinuationToken;
        if (!token) return keys;
      }
      throw new Error(
        `r2 list ${bucket}/${prefix} exceeded ${MAX_LIST_PAGES} pages — refusing to trust the listing`,
      );
    },

    async getText(bucket: string, key: string): Promise<string | null> {
      const res = await send('GET', bucket, key, {});
      if (res.status === 404) return null;
      if (res.status < 200 || res.status >= 300) {
        throw await failure('get', bucket, key, res);
      }
      return res.text();
    },

    async deleteObject(bucket: string, key: string): Promise<void> {
      const res = await send('DELETE', bucket, key, {});
      // S3 DELETE is idempotent: 204 on success, 404 when it was already gone.
      if (res.status === 404) return;
      if (res.status < 200 || res.status >= 300) {
        throw await failure('delete', bucket, key, res);
      }
    },
  };
}
