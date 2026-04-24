/**
 * OCI-style manifest assembler used by the cli push flow.
 *
 * Matches the shape the server validates in
 * `web/app/api/roosts/[roostId]/manifests/route.ts:POST`:
 *
 *   {
 *     schemaVersion: 2,
 *     mediaType: 'application/vnd.owlette.manifest.v1+json',
 *     config: { ... },
 *     files: [{ path, size, chunks: [{hash, size}, ...] }, ...]
 *   }
 *
 * `config` carries free-form metadata about the push (cli version,
 * source host, timestamp). The server ignores unknown keys but writes
 * the whole object into the manifest body in R2 — useful for auditing
 * how a given manifest was produced.
 */

import type { ChunkedFileEntry } from './chunker';

export const MANIFEST_MEDIA_TYPE = 'application/vnd.owlette.manifest.v1+json';
export const MANIFEST_SCHEMA_VERSION = 2;

export interface BuiltManifest {
  schemaVersion: 2;
  mediaType: typeof MANIFEST_MEDIA_TYPE;
  config: Record<string, unknown>;
  files: ChunkedFileEntry[];
}

export interface BuildManifestInput {
  files: readonly ChunkedFileEntry[];
  cliVersion: string;
  hostname?: string;
  platform?: string;
  extra?: Record<string, unknown>;
}

export function buildManifest(input: BuildManifestInput): BuiltManifest {
  const config: Record<string, unknown> = {
    producer: 'roost-cli',
    cliVersion: input.cliVersion,
    createdAt: new Date().toISOString(),
  };
  if (input.hostname) config.hostname = input.hostname;
  if (input.platform) config.platform = input.platform;
  if (input.extra) Object.assign(config, input.extra);

  // Server expects files sorted by path? Not strictly required by the
  // validator but deterministic ordering makes the manifest digest
  // stable across machines + across retries.
  const files = [...input.files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    mediaType: MANIFEST_MEDIA_TYPE,
    config,
    files,
  };
}

/** Dedup the set of chunk hashes referenced by a manifest's files. */
export function uniqueHashes(files: readonly ChunkedFileEntry[]): string[] {
  const set = new Set<string>();
  for (const f of files) {
    for (const c of f.chunks) set.add(c.hash);
  }
  return Array.from(set);
}

/** Quick stats for the pre-upload summary line. */
export function summariseManifest(files: readonly ChunkedFileEntry[]): {
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
