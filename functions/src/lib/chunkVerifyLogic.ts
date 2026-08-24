/**
 * Pure logic for roost chunk hash verification, split from the handler so it is
 * testable without cloud storage.
 *
 * Chunks live at `project-content/{siteId}/{hashPrefix}/{hash}`; the filename IS
 * the content address. A signed upload URL doesn't stop a client PUTting bytes
 * that hash to something else, and agents downloading by hash would then trust
 * a violated CAS invariant — so mismatches are deleted.
 */

/** Object-path prefix under which all roost chunk content lives. */
export const CHUNK_PATH_PREFIX = 'project-content';

/** SHA-256 hex is always 64 lowercase chars. */
const HASH_HEX_RE = /^[0-9a-f]{64}$/;

export interface ParsedChunkPath {
  siteId: string;
  hashPrefix: string;
  hash: string;
}

/**
 * Parse `project-content/{siteId}/{hashPrefix}/{hash}`, or null if it doesn't
 * match: 4 segments, valid siteId, 64-char lowercase hex hash, prefix equal to
 * the hash's first 2 chars.
 *
 * Malformed paths are deleted like hash mismatches — an object whose path we
 * can't parse isn't one we trust.
 */
export function parseChunkPath(objectPath: string): ParsedChunkPath | null {
  if (typeof objectPath !== 'string' || objectPath.length === 0) return null;

  const segments = objectPath.split('/');
  if (segments.length !== 4) return null;

  const [prefix, siteId, hashPrefix, hash] = segments;
  if (prefix !== CHUNK_PATH_PREFIX) return null;
  if (!isValidSiteId(siteId)) return null;
  if (!HASH_HEX_RE.test(hash)) return null;
  if (hashPrefix !== hash.slice(0, 2)) return null;

  return { siteId, hashPrefix, hash };
}

function isValidSiteId(s: string): boolean {
  // Caller-created, so treated as hostile: a slash or '..' would break the
  // 4-segment split this parser depends on.
  if (!s || s.length === 0 || s.length > 128) return false;
  if (s.includes('/') || s.includes('\\') || s.includes('..')) return false;
  if (s === '.' || s === '..') return false;
  // Identifier charset only; exotic bytes buy a confused-deputy class of bug.
  return /^[A-Za-z0-9_\-.]+$/.test(s);
}

export type Verdict =
  | { ok: true; parsed: ParsedChunkPath }
  | {
      ok: false;
      reason: 'malformed_path' | 'hash_mismatch';
      parsed: ParsedChunkPath | null;
      /** the computed hash, when we got to compute one */
      computedHash?: string;
    };

/**
 * Keep-or-delete decision from the path plus `computedHashHex`, the 64-char hex
 * sha-256 of the stored bytes (the caller does the streaming).
 */
export function verdict(
  objectPath: string,
  computedHashHex: string,
): Verdict {
  const parsed = parseChunkPath(objectPath);
  if (!parsed) {
    return { ok: false, reason: 'malformed_path', parsed: null };
  }

  // A wrong-shaped input still fails the regex + equality check below.
  const computed = typeof computedHashHex === 'string' ? computedHashHex.toLowerCase() : '';

  if (!HASH_HEX_RE.test(computed) || computed !== parsed.hash) {
    return {
      ok: false,
      reason: 'hash_mismatch',
      parsed,
      computedHash: computed || undefined,
    };
  }

  return { ok: true, parsed };
}

export interface AlertPayload {
  event: 'chunk_verify_failed';
  objectPath: string;
  siteId: string | null;
  reason: 'malformed_path' | 'hash_mismatch';
  expectedHash: string | null;
  computedHash: string | null;
  timestamp: string; // ISO-8601
}

/** Build a structured alert payload for logging / downstream sinks. */
export function buildAlert(
  objectPath: string,
  v: Extract<Verdict, { ok: false }>,
  now: Date = new Date(),
): AlertPayload {
  return {
    event: 'chunk_verify_failed',
    objectPath,
    siteId: v.parsed?.siteId ?? null,
    reason: v.reason,
    expectedHash: v.parsed?.hash ?? null,
    computedHash: v.computedHash ?? null,
    timestamp: now.toISOString(),
  };
}
