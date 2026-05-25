/**
 * OCI-style version body assembler used by the cli push flow.
 *
 * Matches the shape the server validates in
 * `web/app/api/roosts/[roostId]/versions/route.ts:POST`:
 *
 *   {
 *     schemaVersion: 2,
 *     mediaType: 'application/vnd.owlette.version.v1+json',
 *     config: { ... },
 *     files: [{ path, size, chunks: [{hash, size}, ...] }, ...]
 *   }
 *
 * `config` carries free-form metadata about the push (cli version,
 * source host). The server ignores unknown keys but writes
 * the whole object into the version body in R2 — useful for auditing
 * how a given version was produced.
 */

import { createHash } from 'crypto';
import type { ChunkedFileEntry } from './chunker';

export const VERSION_MEDIA_TYPE = 'application/vnd.owlette.version.v1+json';
export const VERSION_SCHEMA_VERSION = 2;

export interface BuiltVersion {
  schemaVersion: 2;
  mediaType: typeof VERSION_MEDIA_TYPE;
  config: Record<string, unknown>;
  files: ChunkedFileEntry[];
}

export interface BuildVersionInput {
  files: readonly ChunkedFileEntry[];
  cliVersion: string;
  hostname?: string;
  platform?: string;
  extra?: Record<string, unknown>;
}

export function buildVersion(input: BuildVersionInput): BuiltVersion {
  const config: Record<string, unknown> = {
    producer: 'owlette-cli',
    cliVersion: input.cliVersion,
  };
  if (input.hostname) config.hostname = input.hostname;
  if (input.platform) config.platform = input.platform;
  if (input.extra) Object.assign(config, input.extra);

  // Server doesn't strictly require files to be path-sorted, but
  // deterministic ordering makes the version digest stable across
  // machines + across retries.
  const files = [...input.files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );

  return {
    schemaVersion: VERSION_SCHEMA_VERSION,
    mediaType: VERSION_MEDIA_TYPE,
    config,
    files,
  };
}

/** Canonical JSON form used by the server when deriving the content address. */
export function canonicalVersionJson(version: BuiltVersion): string {
  return JSON.stringify(sortForCanonical(version));
}

/** SHA-256 content address for a built version body. */
export function versionIdForVersion(version: BuiltVersion): string {
  return createHash('sha256').update(canonicalVersionJson(version)).digest('hex');
}

/** Dedup the set of chunk hashes referenced by a version's files. */
export function uniqueHashes(files: readonly ChunkedFileEntry[]): string[] {
  const set = new Set<string>();
  for (const f of files) {
    for (const c of f.chunks) set.add(c.hash);
  }
  return Array.from(set);
}

/** Quick stats for the pre-upload summary line. */
export function summariseVersion(files: readonly ChunkedFileEntry[]): {
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
  return {
    fileCount: files.length,
    totalBytes,
    totalChunks,
    uniqueChunks: unique.size,
  };
}

function sortForCanonical(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(sortForCanonical);
  const out: Record<string, unknown> = {};
  const keys = Object.keys(v as Record<string, unknown>).sort();
  for (const k of keys) out[k] = sortForCanonical((v as Record<string, unknown>)[k]);
  return out;
}
