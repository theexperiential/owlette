/**
 * Pure logic for roost chunk hash verification (wave 2b.2).
 *
 * Chunks live at `project-content/{siteId}/{hashPrefix}/{hash}` where
 * `hashPrefix` is the first two chars of the chunk's sha-256 hex. The
 * filename IS the content address — if the bytes on disk hash to
 * something else, the object is either corrupted or planted by an
 * attacker and must be removed.
 *
 * Defense in depth: even if the upload URL was signed (so only the
 * signing service could have issued it), a malicious or buggy client
 * could PUT different bytes than it claimed. Without this verify step,
 * an agent later downloading by hash gets the attacker's bytes,
 * trusting the CAS invariant that was actually violated.
 *
 * Split out from the handler so the decision logic is unit-testable
 * without cloud-storage setup.
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
 * Parse an object path into its structural components, or return null
 * if the shape doesn't match the CAS layout.
 *
 * Accepts:  `project-content/{siteId}/{hashPrefix}/{hash}`
 * Requires:
 *   - exactly 4 non-empty path segments
 *   - first segment === 'project-content'
 *   - siteId matches the Owlette siteId shape (non-empty, no path chars)
 *   - hash is 64 lowercase hex
 *   - hashPrefix is the first 2 chars of hash (matches the shard layout)
 *
 * Anything not matching is malformed. Malformed objects get the same
 * treatment as hash mismatches (deletion) — if we don't understand the
 * path, we don't trust the object.
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
  // siteIds are caller-created but we're defensive: non-empty, no slashes,
  // no '..' (would break our assumption that the 4-segment split = 4 parts),
  // no dot-only (would collide with path traversal).
  if (!s || s.length === 0 || s.length > 128) return false;
  if (s.includes('/') || s.includes('\\') || s.includes('..')) return false;
  if (s === '.' || s === '..') return false;
  // printable ASCII only — siteIds are app-controlled identifiers; rejecting
  // anything exotic short-circuits a whole class of confused-deputy attacks.
  // allow [a-zA-Z0-9-_.] — standard identifier shape.
  return /^[A-Za-z0-9_\-.]+$/.test(s);
}

/* --------------------------------------------------------------------- */
/*  Verdict                                                              */
/* --------------------------------------------------------------------- */

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
 * Decide whether an uploaded object should be kept or deleted, given
 * its path and the sha-256 computed by streaming its bytes.
 *
 * `computedHashHex` is the lowercase 64-char hex digest of the object's
 * stored bytes. Callers stream + compute that; this function just
 * decides the outcome.
 */
export function verdict(
  objectPath: string,
  computedHashHex: string,
): Verdict {
  const parsed = parseChunkPath(objectPath);
  if (!parsed) {
    return { ok: false, reason: 'malformed_path', parsed: null };
  }

  // normalize to lowercase; if the caller passed the wrong shape we'll
  // still reject via the regex-validated `parsed.hash` comparison.
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

/* --------------------------------------------------------------------- */
/*  Alert payload                                                        */
/* --------------------------------------------------------------------- */

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
