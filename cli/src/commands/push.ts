/**
 * `owlette roost push <dir> --to <roostId> --site <siteId>`.
 *
 * End-to-end publish of a directory:
 *
 *   1. walk + chunk (sha-256 4 MiB) — cli/src/lib/chunker.ts
 *   2. POST /api/chunks/check         { siteId, hashes } → { missing }
 *   3. POST /api/chunks/upload-urls   { siteId, missing } → { urls }
 *   4. PUT each signed url (parallel, bounded)
 *   5. POST /api/roosts/{id}/versions with optimistic concurrency — on
 *      412 precondition-failed, re-fetch the current head and retry
 *      (the server's transaction enforces compare-and-swap on
 *      `currentVersionId`).
 *
 * Reads + writes chunks over HTTPS via the signed R2 URLs the server
 * mints — no direct R2 creds on the cli side.
 */

import { createReadStream, promises as fs } from 'fs';
import { hostname, platform } from 'os';
import { join } from 'path';
import { Command } from 'commander';
import { loadConfig } from '../config';
import {
  CHUNK_SIZE_BYTES,
  chunkDirectory,
  type ChunkedFileEntry,
} from '../lib/chunker';
import {
  buildVersion,
  summariseVersion,
  uniqueHashes,
} from '../lib/versionBuilder';

const UPLOAD_CONCURRENCY = 8;
const CHECK_BATCH_SIZE = 900; // server cap is 1000 — stay under.
const PUSH_MAX_RETRIES = 5;
const CLI_VERSION = '0.1.0';
const MAX_DESCRIPTION_LENGTH = 500;

export function registerPushCommand(program: Command): void {
  const roost = (program.commands.find((c) => c.name() === 'roost') as Command) ?? program.command('roost');
  if (!program.commands.includes(roost)) {
    // Only create if not already registered (future-proof against
    // ordering between registerPushCommand + registerRoostInspect...).
    roost.description('manage roosts + versions');
  }

  // Replace any stub `push` subcommand already registered so the real
  // implementation wins when auth/push/etc. files are loaded in any
  // order. commander exposes commands[] as readonly — mutate through
  // an `as Command[]` cast since we need an in-place splice.
  const existing = roost.commands.find((c) => c.name() === 'push');
  if (existing) {
    const list = roost.commands as Command[];
    const idx = list.indexOf(existing);
    if (idx >= 0) list.splice(idx, 1);
  }

  roost
    .command('push <dir>')
    .description('chunk + upload + publish a directory as a new version')
    .requiredOption('--to <roostId>', 'target roost id')
    .requiredOption('--site <siteId>', 'site id that owns the roost')
    .option('--name <name>', 'human-readable display name for the roost')
    .option(
      '-m, --description <text>',
      `commit-message-style summary for this version (≤${MAX_DESCRIPTION_LENGTH} chars)`,
    )
    .option(
      '--targets <machineIds>',
      'comma-separated list of target machine ids (overrides roost.targets)',
    )
    .option('--extract-path <path>', 'extract root override')
    .action(async (dir: string, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const { apiUrl, token, profile } = loadConfig({ profile: globals.profile });
      if (!token) {
        process.stderr.write(
          'owlette: no token configured. run `owlette auth login` or set OWLETTE_TOKEN.\n',
        );
        process.exitCode = 2;
        return;
      }

      const input: PushInputs = {
        apiUrl,
        token,
        profile,
        dir,
        roostId: opts.to,
        siteId: opts.site,
        json: globals.json === true,
      };
      if (opts.name) input.name = opts.name;
      if (opts.extractPath) input.extractPath = opts.extractPath;
      if (opts.targets) {
        input.targets = String(opts.targets)
          .split(',')
          .map((t: string) => t.trim())
          .filter(Boolean);
      }
      if (opts.description !== undefined) {
        const desc = String(opts.description);
        // Cap client-side so operators who paste long strings get an
        // early, local failure instead of a server 400 after a full
        // chunk-upload cycle. The server re-validates the same limit.
        if (desc.length > MAX_DESCRIPTION_LENGTH) {
          process.stderr.write(
            `owlette: --description is ${desc.length} chars; max is ${MAX_DESCRIPTION_LENGTH}.\n`,
          );
          process.exitCode = 2;
          return;
        }
        input.description = desc;
      }
      await runPush(input);
    });
}

/* --------------------------------------------------------------------- */
/*  Orchestrator                                                         */
/* --------------------------------------------------------------------- */

interface PushInputs {
  apiUrl: string;
  token: string;
  profile: string;
  dir: string;
  roostId: string;
  siteId: string;
  name?: string;
  targets?: string[];
  extractPath?: string;
  description?: string;
  json: boolean;
}

async function runPush(input: PushInputs): Promise<void> {
  const { apiUrl, token, dir, roostId, siteId, json } = input;

  const stat = await fs.stat(dir).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    process.stderr.write(`owlette: ${dir} is not a directory\n`);
    process.exitCode = 2;
    return;
  }

  log(json, `owlette: walking ${dir}…`);
  const files = await chunkDirectory(dir, {
    onProgress: (evt) => {
      if (json) return;
      if (evt.phase === 'discover') {
        process.stderr.write(
          `owlette: ${evt.fileCount} files, ${humanBytes(evt.totalBytes)} total\n`,
        );
      } else if (evt.phase === 'hash' && evt.file) {
        process.stderr.write(
          `  [${evt.filesDone}/${evt.filesTotal}] hashing ${evt.file}\n`,
        );
      }
    },
  });

  if (files.length === 0) {
    process.stderr.write('owlette: no non-empty files found — nothing to push\n');
    process.exitCode = 2;
    return;
  }

  const summary = summariseVersion(files);
  log(
    json,
    `owlette: ${summary.fileCount} files / ${summary.totalChunks} chunks ` +
      `(${summary.uniqueChunks} unique) / ${humanBytes(summary.totalBytes)}`,
  );

  const allHashes = uniqueHashes(files);

  log(json, 'owlette: querying server for missing chunks…');
  const missing = await checkMissing({ apiUrl, token, siteId, hashes: allHashes });
  log(
    json,
    `owlette: ${missing.length}/${allHashes.length} chunks need upload ` +
      `(${allHashes.length - missing.length} deduped)`,
  );

  if (missing.length > 0) {
    log(json, 'owlette: minting signed upload urls…');
    const urls = await mintUploadUrls({ apiUrl, token, siteId, hashes: missing });

    log(json, `owlette: uploading ${missing.length} chunks (${UPLOAD_CONCURRENCY}-wide)…`);
    await uploadChunksInParallel({
      missing,
      urls,
      dir,
      files,
      json,
    });
  }

  log(json, 'owlette: publishing version (with optimistic retry on 412)…');
  const version = buildVersion({
    files,
    cliVersion: CLI_VERSION,
    hostname: hostname(),
    platform: platform(),
  });

  const publishInput: PublishInput = {
    apiUrl,
    token,
    siteId,
    roostId,
    version,
  };
  if (input.name) publishInput.name = input.name;
  if (input.targets) publishInput.targets = input.targets;
  if (input.extractPath) publishInput.extractPath = input.extractPath;
  if (input.description !== undefined) publishInput.description = input.description;
  const result = await publishWithRetry(publishInput);

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    const numberLabel =
      typeof result.versionNumber === 'number' ? ` (#${result.versionNumber})` : '';
    process.stdout.write(
      `owlette: published ${result.versionId}${numberLabel}\n` +
        `       previous: ${result.previousVersionId ?? '(none)'}\n`,
    );
  }
}

/* --------------------------------------------------------------------- */
/*  HTTP helpers                                                         */
/* --------------------------------------------------------------------- */

async function apiPost<T>(
  apiUrl: string,
  path: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; data: T; headers: Headers }> {
  const res = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, data, headers: res.headers };
}

interface CheckMissingInput {
  apiUrl: string;
  token: string;
  siteId: string;
  hashes: readonly string[];
}

async function checkMissing(input: CheckMissingInput): Promise<string[]> {
  const missing: string[] = [];
  for (let i = 0; i < input.hashes.length; i += CHECK_BATCH_SIZE) {
    const batch = input.hashes.slice(i, i + CHECK_BATCH_SIZE);
    const res = await apiPost<{ missing?: string[] }>(
      input.apiUrl,
      '/api/chunks/check',
      input.token,
      { siteId: input.siteId, hashes: batch },
    );
    if (res.status !== 200 || !Array.isArray(res.data.missing)) {
      throw new Error(
        `/api/chunks/check failed (${res.status}): ${JSON.stringify(res.data)}`,
      );
    }
    missing.push(...res.data.missing);
  }
  return missing;
}

interface MintUploadUrlsInput {
  apiUrl: string;
  token: string;
  siteId: string;
  hashes: readonly string[];
}

async function mintUploadUrls(input: MintUploadUrlsInput): Promise<Record<string, string>> {
  const all: Record<string, string> = {};
  for (let i = 0; i < input.hashes.length; i += CHECK_BATCH_SIZE) {
    const batch = input.hashes.slice(i, i + CHECK_BATCH_SIZE);
    const res = await apiPost<{ urls?: Record<string, string> }>(
      input.apiUrl,
      '/api/chunks/upload-urls',
      input.token,
      { siteId: input.siteId, hashes: batch },
    );
    if (res.status !== 200 || !res.data.urls) {
      throw new Error(
        `/api/chunks/upload-urls failed (${res.status}): ${JSON.stringify(res.data)}`,
      );
    }
    Object.assign(all, res.data.urls);
  }
  return all;
}

interface UploadChunksInput {
  missing: readonly string[];
  urls: Record<string, string>;
  dir: string;
  files: readonly ChunkedFileEntry[];
  json: boolean;
}

async function uploadChunksInParallel(input: UploadChunksInput): Promise<void> {
  // Build a map from hash → (filePath, chunkIndex) so we can locate the
  // source bytes for each chunk when PUT-ing.
  interface Source {
    absPath: string;
    offset: number;
    size: number;
  }
  const sourceByHash = new Map<string, Source>();
  for (const f of input.files) {
    let offset = 0;
    for (const c of f.chunks) {
      if (!sourceByHash.has(c.hash)) {
        sourceByHash.set(c.hash, {
          absPath: join(input.dir, ...f.path.split('/')),
          offset,
          size: c.size,
        });
      }
      offset += c.size;
    }
  }

  let uploaded = 0;
  const total = input.missing.length;

  const queue = [...input.missing];
  async function worker(): Promise<void> {
    for (;;) {
      const hash = queue.shift();
      if (!hash) return;
      const source = sourceByHash.get(hash);
      const url = input.urls[hash];
      if (!source || !url) {
        throw new Error(`internal: no source for chunk ${hash}`);
      }
      await putChunk(hash, source.absPath, source.offset, source.size, url);
      uploaded += 1;
      if (!input.json && uploaded % 10 === 0) {
        process.stderr.write(`  uploaded ${uploaded}/${total}\n`);
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(UPLOAD_CONCURRENCY, total); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  if (!input.json) {
    process.stderr.write(`  uploaded ${uploaded}/${total}\n`);
  }
}

async function putChunk(
  hash: string,
  absPath: string,
  offset: number,
  size: number,
  url: string,
): Promise<void> {
  // Read the specific byte range from disk. For small chunks (< 4 MiB)
  // we buffer; R2's signed PUT expects a single-shot upload (we don't
  // want multipart here).
  const stream = createReadStream(absPath, {
    start: offset,
    end: offset + size - 1,
  });
  const bufs: Buffer[] = [];
  for await (const chunk of stream) {
    bufs.push(chunk as Buffer);
  }
  const body = Buffer.concat(bufs);
  if (body.length !== size) {
    throw new Error(
      `chunk ${hash}: expected ${size} bytes, read ${body.length} from ${absPath}`,
    );
  }

  // One retry — covers transient R2 5xx / connection resets.
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'PUT',
        body: new Uint8Array(body),
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      if (!res.ok) {
        throw new Error(`PUT ${hash} → ${res.status} ${await res.text().catch(() => '')}`);
      }
      return;
    } catch (err) {
      lastErr = err as Error;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw lastErr ?? new Error(`PUT ${hash}: unknown error`);
}

interface PublishInput {
  apiUrl: string;
  token: string;
  siteId: string;
  roostId: string;
  version: ReturnType<typeof buildVersion>;
  name?: string;
  targets?: string[];
  extractPath?: string;
  description?: string;
}

interface PublishResult {
  versionId: string;
  versionNumber?: number;
  currentVersionId: string;
  previousVersionId: string | null;
}

async function publishWithRetry(input: PublishInput): Promise<PublishResult> {
  let expectedCurrent: string | null = null;
  let lastStatus = 0;
  let lastBody: unknown = null;

  for (let attempt = 0; attempt < PUSH_MAX_RETRIES; attempt++) {
    const payload: Record<string, unknown> = {
      siteId: input.siteId,
      version: input.version,
    };
    if (expectedCurrent !== null) payload.expectedCurrentVersionId = expectedCurrent;
    if (input.name) payload.name = input.name;
    if (input.targets && input.targets.length > 0) payload.targets = input.targets;
    if (input.extractPath) payload.extractPath = input.extractPath;
    if (input.description !== undefined) payload.description = input.description;

    const res = await apiPost<
      PublishResult & { currentId?: string | null; detail?: string }
    >(
      input.apiUrl,
      `/api/roosts/${input.roostId}/versions`,
      input.token,
      payload,
    );

    if (res.status === 201 || res.status === 200) {
      const result: PublishResult = {
        versionId: res.data.versionId,
        currentVersionId: res.data.currentVersionId,
        previousVersionId: res.data.previousVersionId ?? null,
      };
      if (typeof res.data.versionNumber === 'number') {
        result.versionNumber = res.data.versionNumber;
      }
      return result;
    }

    lastStatus = res.status;
    lastBody = res.data;

    // 412 = head changed mid-flight → refresh expected head + retry.
    if (res.status === 412) {
      const detail = (res.data as { detail?: string; currentId?: string }).detail ?? '';
      const matched = /\((?<cur>[a-f0-9-]+|null)\)/.exec(detail)?.groups?.cur ?? null;
      expectedCurrent =
        matched && matched !== 'null' ? matched : (res.data as { currentId?: string }).currentId ?? null;
      continue;
    }

    // Anything else is unrecoverable.
    break;
  }

  throw new Error(
    `version publish failed after ${PUSH_MAX_RETRIES} attempts (last ${lastStatus}): ${JSON.stringify(lastBody)}`,
  );
}

/* --------------------------------------------------------------------- */
/*  small utilities                                                      */
/* --------------------------------------------------------------------- */

function log(json: boolean, msg: string): void {
  if (!json) process.stderr.write(msg + '\n');
}

function humanBytes(n: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v < 10 && u > 0 ? 2 : 1)} ${units[u]}`;
}

/** Export for tests. */
export const _internals = {
  CHUNK_SIZE_BYTES,
  humanBytes,
  publishWithRetry,
  checkMissing,
  mintUploadUrls,
};
