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
 * source host, timestamp). The server ignores unknown keys but writes
 * the whole object into the version body in R2 — useful for auditing
 * how a given version was produced.
 */

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
    producer: 'roost-cli',
    cliVersion: input.cliVersion,
    createdAt: new Date().toISOString(),
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
